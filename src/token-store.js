// Credential storage in ~/.kimi-gpt-bridge (or $KGB_HOME) with safe refresh semantics.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshTokens, extractAccountInfo } from './oauth.js';

export function kgbHome() {
  return process.env.KGB_HOME || path.join(os.homedir(), '.kimi-gpt-bridge');
}

export function authPath() {
  return path.join(kgbHome(), 'auth.json');
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
export function saveAuth(auth) {
  const dir = kgbHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const file = authPath();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function deleteAuth() {
  try { fs.rmSync(authPath()); } catch { /* missing is fine */ }
}

const PERMANENT_REFRESH_CODES = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_grant',
]);

function isPermanentRefreshError(err) {
  return err?.status === 401 || PERMANENT_REFRESH_CODES.has(err?.code);
}

// In-process mutex: concurrent refreshes share one request, because a reused
// (rotated) refresh token permanently kills the token chain.
let inFlightRefresh = null;

async function doRefresh(fetchImpl) {
  const current = loadAuth();
  if (!current) throw new Error('Not logged in. Run `kimi-gpt-bridge login` first.');
  try {
    const tokens = await refreshTokens(current.refresh, fetchImpl);
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
    saveAuth(next);
    return next;
  } catch (err) {
    if (isPermanentRefreshError(err)) {
      throw new Error(`ChatGPT session is no longer valid — run \`kimi-gpt-bridge login\` again. (${err.message})`);
    }
    throw err;
  }
}

// Force a refresh (used for the single retry after an upstream 401).
export function refreshNow(fetchImpl = fetch) {
  if (!inFlightRefresh) {
    inFlightRefresh = doRefresh(fetchImpl).finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

// Returns a valid auth record, refreshing when less than 5 minutes remain.
export async function getValidToken(fetchImpl = fetch) {
  const auth = loadAuth();
  if (!auth) throw new Error('Not logged in. Run `kimi-gpt-bridge login` first.');
  if (Date.now() + 300_000 < auth.expires) return auth;
  return refreshNow(fetchImpl);
}
