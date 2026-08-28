// Credential storage in ~/.kimi-gpt-bridge (or $KGB_HOME) with safe refresh semantics.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshTokens, extractAccountInfo } from './oauth.js';

const LOCK_WAIT_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 120_000;
const LOCK_RETRY_MS = 25;
const lockStates = new Map();

export function kgbHome() {
  return process.env.KGB_HOME || path.join(os.homedir(), '.kimi-gpt-bridge');
}

export function authPath() {
  return path.join(kgbHome(), 'auth.json');
}

function ensureHome() {
  const dir = kgbHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
}

function lockPath(file = authPath()) {
  return `${file}.lock`;
}

function lockState(file) {
  let state = lockStates.get(file);
  if (!state) {
    state = { active: null, pendingMutations: [] };
    lockStates.set(file, state);
  }
  return state;
}

function recoveryGuardPath(file) {
  return `${lockPath(file)}.recovery`;
}

function readLockOwnerAt(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return {};
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function recoverLockFile(file) {
  const owner = readLockOwnerAt(file);
  if (owner === null) return true;
  let modifiedAt;
  try {
    modifiedAt = fs.statSync(file).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
  const validPid = Number.isSafeInteger(owner.pid) && owner.pid > 0;
  if (validPid && processIsAlive(owner.pid)) return false;
  const createdAt = Number.isFinite(owner.time) ? owner.time : modifiedAt;
  if (!validPid && Date.now() - createdAt <= LOCK_STALE_MS) return false;
  try {
    fs.rmSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return true;
}

function tryAcquireLockFile(file) {
  const owner = { pid: process.pid, time: Date.now(), id: crypto.randomUUID() };
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(owner));
    return owner;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function releaseLockFile(file, owner) {
  const current = readLockOwnerAt(file);
  try {
    if (current?.id === owner.id) fs.rmSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Every acquisition takes this independent guard before inspecting or removing
// the credential lock, so a stale-owner check cannot delete a newly acquired lock.
function tryAcquireProtectedLock(file) {
  const guardFile = recoveryGuardPath(file);
  let guard = tryAcquireLockFile(guardFile);
  if (!guard && recoverLockFile(guardFile)) guard = tryAcquireLockFile(guardFile);
  if (!guard) return null;
  try {
    let owner = tryAcquireLockFile(lockPath(file));
    if (owner) return owner;
    if (!recoverLockFile(lockPath(file))) return null;
    owner = tryAcquireLockFile(lockPath(file));
    return owner;
  } finally {
    releaseLockFile(guardFile, guard);
  }
}

function lockTimeout(file) {
  const err = new Error(`Timed out waiting for credential lock ${lockPath(file)}`);
  err.code = 'KGB_AUTH_LOCK_TIMEOUT';
  return err;
}

function lockBusy(file) {
  const err = new Error(`Credential lock ${lockPath(file)} is busy in this process`);
  err.code = 'KGB_AUTH_LOCK_BUSY';
  return err;
}

function abortReason(signal) {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function acquireLockSync(file, state) {
  ensureHome();
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    const owner = tryAcquireProtectedLock(file);
    if (owner) {
      state.active = owner;
      return owner;
    }
    if (Date.now() >= deadline) throw lockTimeout(file);
    sleepSync(LOCK_RETRY_MS);
  }
}

async function acquireLock(file, state, signal) {
  ensureHome();
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    throwIfAborted(signal);
    const owner = tryAcquireProtectedLock(file);
    if (owner) {
      state.active = owner;
      return owner;
    }
    if (Date.now() >= deadline) throw lockTimeout(file);
    await sleep(LOCK_RETRY_MS, signal);
  }
}

function releaseLock(file, state, owner) {
  try {
    releaseLockFile(lockPath(file), owner);
  } finally {
    if (state.active?.id === owner.id) state.active = null;
  }
}

function queueMutation(state, operation, waitForResult = false) {
  if (!waitForResult) {
    state.pendingMutations.push({ operation });
    return undefined;
  }
  return new Promise((resolve, reject) => {
    state.pendingMutations.push({ operation, resolve, reject });
  });
}

function drainMutations(state) {
  let firstUnobservedError;
  for (const pending of state.pendingMutations.splice(0)) {
    try {
      pending.operation();
      pending.resolve?.();
    } catch (err) {
      pending.reject?.(err);
      if (!pending.reject && !firstUnobservedError) firstUnobservedError = err;
    }
  }
  if (firstUnobservedError) throw firstUnobservedError;
}

async function withAuthLock(operation, signal) {
  const file = authPath();
  const state = lockState(file);
  const owner = await acquireLock(file, state, signal);
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (err) {
    operationError = err;
  }
  let cleanupError;
  try {
    drainMutations(state);
  } catch (err) {
    cleanupError = err;
  }
  try {
    releaseLock(file, state, owner);
  } catch (err) {
    cleanupError ??= err;
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return result;
}

function runMutationSync(operation) {
  const file = authPath();
  const state = lockState(file);
  if (state.active) throw lockBusy(file);
  const owner = acquireLockSync(file, state);
  try {
    operation();
  } finally {
    releaseLock(file, state, owner);
  }
  return undefined;
}

async function runMutation(operation) {
  const file = authPath();
  const state = lockState(file);
  if (state.active) return queueMutation(state, operation, true);
  return withAuthLock(operation);
}

export function loadAuth() {
  try {
    const raw = fs.readFileSync(authPath(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || !data.access) return null;
    return data;
  } catch {
    return null;
  }
}

// Atomic write (tmp file + rename) with 0o600 permissions; home dir is 0o700.
function writeAuthUnlocked(serialized) {
  const file = authPath();
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, serialized, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp); } catch (cleanupErr) {
      if (cleanupErr.code !== 'ENOENT') err.cleanupError = cleanupErr;
    }
    throw err;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function saveAuth(auth) {
  const serialized = JSON.stringify(auth, null, 2);
  return runMutationSync(() => writeAuthUnlocked(serialized));
}

export function saveAuthAsync(auth) {
  const serialized = JSON.stringify(auth, null, 2);
  return runMutation(() => writeAuthUnlocked(serialized));
}

function deleteAuthUnlocked() {
  try {
    fs.rmSync(authPath());
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Kept for callers that need synchronous behavior; new async callers should
// await deleteAuthAsync so an in-process refresh can finish first.
export function deleteAuth() {
  return runMutationSync(deleteAuthUnlocked);
}

export function deleteAuthAsync() {
  return runMutation(deleteAuthUnlocked);
}

const PERMANENT_REFRESH_CODES = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_grant',
]);

function authenticationError(message, code, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.status = 401;
  err.type = 'authentication_error';
  err.code = code;
  return err;
}

function notLoggedInError() {
  return authenticationError(
    'Not logged in. Run `kimi-gpt-bridge login` first.',
    'authentication_required',
  );
}

function isPermanentRefreshError(err) {
  return err?.status === 401 || PERMANENT_REFRESH_CODES.has(err?.code);
}

function expectedAuthMatches(current, expected) {
  if (expected === undefined || expected === null) return true;
  if (typeof expected === 'string') return current.refresh === expected;
  if (expected.refresh !== undefined && current.refresh !== expected.refresh) return false;
  if (expected.access !== undefined && current.access !== expected.access) return false;
  return true;
}

async function doRefresh(fetchImpl, expected, signal) {
  return withAuthLock(async () => {
    throwIfAborted(signal);
    const current = loadAuth();
    if (!current) throw notLoggedInError();
    // Another process may have rotated the refresh token while this caller was
    // waiting. Reuse that result instead of rotating the new token again.
    if (!expectedAuthMatches(current, expected)) return current;
    try {
      const tokens = await refreshTokens(current.refresh, fetchImpl, signal);
      const info = extractAccountInfo(tokens.access);
      const next = {
        access: tokens.access,
        refresh: tokens.refresh,
        expires: tokens.expires,
        accountId: info.accountId ?? current.accountId,
      };
      const email = info.email ?? current.email;
      const planType = info.planType ?? current.planType;
      if (email) next.email = email;
      if (planType) next.planType = planType;
      writeAuthUnlocked(JSON.stringify(next, null, 2));
      return next;
    } catch (err) {
      if (isPermanentRefreshError(err)) {
        throw authenticationError(
          `ChatGPT session is no longer valid — run \`kimi-gpt-bridge login\` again. (${err.message})`,
          'session_invalid',
          err,
        );
      }
      throw err;
    }
  }, signal);
}

// Force a refresh (used for the single retry after an upstream 401). Passing
// the auth record (or refresh token) used by the failed request prevents a
// waiter from rotating credentials that another process has already refreshed.
export function refreshNow(fetchImpl = fetch, expected, signal) {
  return doRefresh(fetchImpl, expected, signal);
}

// Returns a valid auth record, refreshing when less than 5 minutes remain.
export async function getValidToken(fetchImpl = fetch, signal) {
  throwIfAborted(signal);
  const auth = loadAuth();
  if (!auth) throw notLoggedInError();
  if (Date.now() + 300_000 < auth.expires) return auth;
  return refreshNow(fetchImpl, auth, signal);
}
