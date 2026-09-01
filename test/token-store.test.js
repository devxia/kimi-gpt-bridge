import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  loadAuth,
  saveAuth,
  saveAuthAsync,
  deleteAuth,
  deleteAuthAsync,
  getValidToken,
  refreshNow,
  authPath,
  kgbHome,
} from '../src/token-store.js';

const execFileAsync = promisify(execFile);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test fixture');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A syntactically valid (unsigned) JWT so extractAccountInfo works during refresh.
function fakeJwt(accountId = 'acct_test', plan = 'plus', email = 'u@example.com') {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan }, email })}.`;
}

let tmpDir;
test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-test-'));
  process.env.KGB_HOME = tmpDir;
});
test.afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.KGB_HOME;
});

test('save/load roundtrip and file mode 0600', () => {
  const auth = { access: 'a', refresh: 'r', expires: Date.now() + 3600_000, accountId: 'acct' };
  saveAuth(auth);
  assert.deepEqual(loadAuth(), auth);
  assert.equal(fs.statSync(authPath()).mode & 0o777, 0o600);
  assert.equal(kgbHome(), tmpDir);
});

test('loadAuth returns null when no credentials exist', () => {
  assert.equal(loadAuth(), null);
  deleteAuth(); // must not throw
});

test('getValidToken returns the stored token when it has >5min left', async () => {
  saveAuth({ access: 'a', refresh: 'r', expires: Date.now() + 3600_000, accountId: 'acct' });
  const fetchImpl = () => assert.fail('fetch must not be called');
  const auth = await getValidToken(fetchImpl);
  assert.equal(auth.access, 'a');
});

test('refresh triggers when <5min left and the rotated refresh token is persisted', async () => {
  saveAuth({ access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' });
  const newAccess = fakeJwt('acct', 'pro', 'new@example.com');
  const fetchImpl = async (url, opts) => {
    assert.match(opts.body, /grant_type=refresh_token/);
    assert.match(opts.body, /refresh_token=r1/);
    return {
      ok: true,
      text: async () => JSON.stringify({ access_token: newAccess, refresh_token: 'r2', expires_in: 3600 }),
    };
  };
  const auth = await getValidToken(fetchImpl);
  assert.equal(auth.access, newAccess);
  assert.equal(auth.planType, 'pro');
  const stored = loadAuth();
  assert.equal(stored.refresh, 'r2'); // rotation persisted
  assert.ok(stored.expires > Date.now() + 300_000);
});

test('concurrent getValidToken calls share one refresh request', async () => {
  saveAuth({ access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 30));
    return {
      ok: true,
      text: async () => JSON.stringify({ access_token: fakeJwt(), refresh_token: 'r2', expires_in: 3600 }),
    };
  };
  const [a, b, c] = await Promise.all([getValidToken(fetchImpl), getValidToken(fetchImpl), getValidToken(fetchImpl)]);
  assert.equal(calls, 1);
  assert.equal(a.access, b.access);
  assert.equal(b.access, c.access);
});

test('permanent refresh failure produces an actionable re-login error', async () => {
  saveAuth({ access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' });
  for (const body of [
    JSON.stringify({ error: 'invalid_grant' }),
    JSON.stringify({ error: { code: 'refresh_token_reused', message: 'reused' } }),
    JSON.stringify({ error: { code: 'refresh_token_expired', message: 'expired' } }),
  ]) {
    const fetchImpl = async () => ({ ok: false, status: 400, text: async () => body });
    await assert.rejects(getValidToken(fetchImpl), /login/);
  }
  const unauthorized = async () => ({ ok: false, status: 401, text: async () => '{}' });
  await assert.rejects(getValidToken(unauthorized), /login/);
});

test('missing credentials produce a clear not-logged-in error', async () => {
  await assert.rejects(getValidToken(async () => assert.fail()), (err) => {
    assert.match(err.message, /login/);
    assert.equal(err.status, 401);
    assert.equal(err.type, 'authentication_error');
    assert.equal(err.code, 'authentication_required');
    return true;
  });
});

test('permanent refresh errors preserve authentication metadata', async () => {
  await saveAuth({ access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' });
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: 'invalid_grant' }),
  });
  await assert.rejects(getValidToken(fetchImpl), (err) => {
    assert.match(err.message, /login/);
    assert.equal(err.status, 401);
    assert.equal(err.type, 'authentication_error');
    assert.equal(err.code, 'session_invalid');
    return true;
  });
});

test('refreshNow accepts expected auth or refresh token and reuses changed auth', async () => {
  const expected = { access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' };
  const replacement = { access: 'new-login', refresh: 'new-refresh', expires: Date.now() + 3600_000, accountId: 'acct' };
  for (const expectation of [expected, expected.refresh]) {
    await saveAuth(expected);
    await saveAuth(replacement);
    const auth = await refreshNow(() => assert.fail('stale refresh must not be used'), expectation);
    assert.deepEqual(auth, replacement);
  }
});

test('an async save started during refresh waits and wins after refresh completes', async () => {
  const expected = { access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' };
  const replacement = { access: 'new-login', refresh: 'new-refresh', expires: Date.now() + 3600_000, accountId: 'acct' };
  await saveAuth(expected);
  let releaseFetch;
  const fetchStarted = deferred();
  const refresh = refreshNow(async () => {
    fetchStarted.resolve();
    await new Promise((resolve) => { releaseFetch = resolve; });
    return {
      ok: true,
      text: async () => JSON.stringify({ access_token: fakeJwt(), refresh_token: 'r2', expires_in: 3600 }),
    };
  }, expected);
  await fetchStarted.promise;
  const save = saveAuthAsync(replacement);
  releaseFetch();
  await Promise.all([refresh, save]);
  assert.deepEqual(loadAuth(), replacement);
});

test('synchronous save and delete report a busy in-process async lock', async () => {
  const expected = { access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' };
  await saveAuth(expected);
  const fetchStarted = deferred();
  const releaseFetch = deferred();
  const refresh = refreshNow(async () => {
    fetchStarted.resolve();
    await releaseFetch.promise;
    return {
      ok: true,
      text: async () => JSON.stringify({ access_token: fakeJwt(), refresh_token: 'r2', expires_in: 3600 }),
    };
  }, expected);
  await fetchStarted.promise;
  const isBusy = (err) => err.code === 'KGB_AUTH_LOCK_BUSY';
  assert.throws(() => saveAuth({ ...expected, access: 'replacement' }), isBusy);
  assert.throws(() => deleteAuth(), isBusy);
  releaseFetch.resolve();
  await refresh;
});

test('delete waits for an in-flight refresh so credentials stay deleted', async () => {
  const expected = { access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' };
  await saveAuth(expected);
  let releaseFetch;
  const fetchStarted = deferred();
  const refresh = refreshNow(async () => {
    fetchStarted.resolve();
    await new Promise((resolve) => { releaseFetch = resolve; });
    return {
      ok: true,
      text: async () => JSON.stringify({ access_token: fakeJwt(), refresh_token: 'r2', expires_in: 3600 }),
    };
  }, expected);
  await fetchStarted.promise;
  const deletion = deleteAuthAsync();
  releaseFetch();
  await Promise.all([refresh, deletion]);
  assert.equal(loadAuth(), null);
});

test('deleteAuth does not swallow filesystem errors other than ENOENT', async () => {
  fs.mkdirSync(authPath(), { recursive: true });
  await assert.rejects(deleteAuthAsync(), (err) => err.code === 'EISDIR' || err.code === 'ERR_FS_EISDIR');
});

test('dead owners and stale locks without a valid PID are recovered', async () => {
  const original = { access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' };
  const lockFile = `${authPath()}.lock`;
  for (const owner of [
    { pid: 2_147_483_647, time: Date.now() },
    { pid: 'invalid', time: 0 },
  ]) {
    await saveAuth(original);
    fs.writeFileSync(lockFile, JSON.stringify(owner), { mode: 0o600 });
    const auth = await getValidToken(async () => ({
      ok: true,
      text: async () => JSON.stringify({ access_token: fakeJwt(), refresh_token: 'r2', expires_in: 3600 }),
    }));
    assert.equal(auth.refresh, 'r2');
    assert.equal(fs.existsSync(lockFile), false);
  }
});

test('an old lock owned by a live PID is recovered only after the 7-day hard limit', async () => {
  const original = { access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' };
  await saveAuth(original);
  const lockFile = `${authPath()}.lock`;
  // A lock that is 6 days old: still below the 7-day threshold, must not be recovered.
  const sixDaysAgo = Date.now() - 6 * 24 * 3600_000;
  const youngOwner = { pid: process.pid, time: sixDaysAgo, id: 'young-live-owner' };
  fs.writeFileSync(lockFile, JSON.stringify(youngOwner), { mode: 0o600 });
  const controller = new AbortController();
  const reason = new DOMException('stop waiting', 'AbortError');
  const refresh = getValidToken(async () => ({
    ok: true,
    text: async () => JSON.stringify({ access_token: fakeJwt(), refresh_token: 'r2', expires_in: 3600 }),
  }), controller.signal);
  setTimeout(() => controller.abort(reason), 50);
  await assert.rejects(refresh, (err) => err === reason);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')), youngOwner);

  // A lock that is 8 days old: exceeds the 7-day hard limit, must be recovered.
  const eightDaysAgo = Date.now() - 8 * 24 * 3600_000;
  const oldOwner = { pid: process.pid, time: eightDaysAgo, id: 'ancient-live-owner' };
  fs.writeFileSync(lockFile, JSON.stringify(oldOwner), { mode: 0o600 });
  const refreshed = await getValidToken(async () => ({
    ok: true,
    text: async () => JSON.stringify({ access_token: fakeJwt(), refresh_token: 'r3', expires_in: 3600 }),
  }));
  assert.equal(refreshed.refresh, 'r3');
  assert.equal(fs.existsSync(lockFile), false, 'ancient lock was not reclaimed');
});

test('two Node processes recover one stale lock without a check-delete race', async () => {
  const original = { access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' };
  await saveAuth(original);
  const lockFile = `${authPath()}.lock`;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 'invalid', time: 0 }), { mode: 0o600 });
  const callsFile = path.join(tmpDir, 'recovery-calls');
  const startFile = path.join(tmpDir, 'recovery-start');
  const releaseFile = path.join(tmpDir, 'recovery-release');
  const secondReadFile = path.join(tmpDir, 'recovery-second-read');
  const firstAcquiredFile = path.join(tmpDir, 'recovery-first-acquired');
  const moduleUrl = new URL('../src/token-store.js', import.meta.url).href;
  const childScript = `
    import fs from 'node:fs';
    const waitForFile = (file, timeoutMs = 500) => {
      const deadline = Date.now() + timeoutMs;
      while (!fs.existsSync(file) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    };
    const originalReadFileSync = fs.readFileSync;
    const originalOpenSync = fs.openSync;
    const originalRmSync = fs.rmSync;
    if (process.env.ROLE === 'first') {
      fs.rmSync = (file, ...args) => {
        if (file === process.env.LOCK_FILE) waitForFile(process.env.SECOND_READ_FILE);
        return originalRmSync(file, ...args);
      };
      fs.openSync = (file, ...args) => {
        const fd = originalOpenSync(file, ...args);
        if (file === process.env.LOCK_FILE && args[0] === 'wx') {
          fs.writeFileSync(process.env.FIRST_ACQUIRED_FILE, 'acquired');
        }
        return fd;
      };
    } else {
      fs.readFileSync = (file, ...args) => {
        const result = originalReadFileSync(file, ...args);
        if (file === process.env.LOCK_FILE) fs.writeFileSync(process.env.SECOND_READ_FILE, 'read');
        return result;
      };
      fs.rmSync = (file, ...args) => {
        if (file === process.env.LOCK_FILE) waitForFile(process.env.FIRST_ACQUIRED_FILE);
        return originalRmSync(file, ...args);
      };
    }
    const { getValidToken } = await import(${JSON.stringify(moduleUrl)});
    waitForFile(process.env.START_FILE, 2_000);
    const auth = await getValidToken(async () => {
      fs.appendFileSync(process.env.CALLS_FILE, process.pid + '\\n');
      waitForFile(process.env.RELEASE_FILE, 2_000);
      return {
        ok: true,
        text: async () => JSON.stringify({
          access_token: ${JSON.stringify(fakeJwt())},
          refresh_token: 'r2',
          expires_in: 3600,
        }),
      };
    });
    process.stdout.write(auth.refresh);
  `;
  const env = {
    ...process.env,
    KGB_HOME: tmpDir,
    LOCK_FILE: lockFile,
    CALLS_FILE: callsFile,
    START_FILE: startFile,
    RELEASE_FILE: releaseFile,
    SECOND_READ_FILE: secondReadFile,
    FIRST_ACQUIRED_FILE: firstAcquiredFile,
  };
  const first = execFileAsync(process.execPath, ['--input-type=module', '--eval', childScript], {
    env: { ...env, ROLE: 'first' },
  });
  const second = execFileAsync(process.execPath, ['--input-type=module', '--eval', childScript], {
    env: { ...env, ROLE: 'second' },
  });
  try {
    fs.writeFileSync(startFile, 'start');
    await waitFor(() => fs.existsSync(callsFile));
    await new Promise((resolve) => setTimeout(resolve, 700));
    fs.writeFileSync(releaseFile, 'release');
    const results = await Promise.all([first, second]);
    assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 1);
    for (const result of results) assert.equal(result.stdout, 'r2');
  } finally {
    fs.writeFileSync(releaseFile, 'release');
    await Promise.allSettled([first, second]);
  }
});

test('two Node processes serialize refresh-token rotation through the file lock', async () => {
  const original = { access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' };
  await saveAuth(original);
  const callsFile = path.join(tmpDir, 'refresh-calls');
  const enteredFile = path.join(tmpDir, 'refresh-entered');
  const releaseFile = path.join(tmpDir, 'refresh-release');
  const moduleUrl = new URL('../src/token-store.js', import.meta.url).href;
  const childScript = `
    import fs from 'node:fs';
    import { getValidToken } from ${JSON.stringify(moduleUrl)};
    const fetchImpl = async () => {
      fs.appendFileSync(process.env.CALLS_FILE, process.pid + '\\n');
      fs.writeFileSync(process.env.ENTERED_FILE, 'entered');
      while (!fs.existsSync(process.env.RELEASE_FILE)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return {
        ok: true,
        text: async () => JSON.stringify({
          access_token: ${JSON.stringify(fakeJwt())},
          refresh_token: 'r2',
          expires_in: 3600,
        }),
      };
    };
    const auth = await getValidToken(fetchImpl);
    process.stdout.write(JSON.stringify({ access: auth.access, refresh: auth.refresh }));
  `;
  const env = {
    ...process.env,
    KGB_HOME: tmpDir,
    CALLS_FILE: callsFile,
    ENTERED_FILE: enteredFile,
    RELEASE_FILE: releaseFile,
  };
  const first = execFileAsync(process.execPath, ['--input-type=module', '--eval', childScript], { env });
  let second;
  try {
    await waitFor(() => fs.existsSync(enteredFile));
    second = execFileAsync(process.execPath, ['--input-type=module', '--eval', childScript], { env });
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(releaseFile, 'release');
    const results = await Promise.all([first, second]);
    assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 1);
    for (const result of results) assert.equal(JSON.parse(result.stdout).refresh, 'r2');
  } finally {
    fs.writeFileSync(releaseFile, 'release');
    await Promise.allSettled([first, second].filter(Boolean));
  }
});

test('logout in another Node process waits for refresh and removes its result', async () => {
  const original = { access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' };
  await saveAuth(original);
  const enteredFile = path.join(tmpDir, 'logout-refresh-entered');
  const releaseFile = path.join(tmpDir, 'logout-refresh-release');
  const moduleUrl = new URL('../src/token-store.js', import.meta.url).href;
  const refreshScript = `
    import fs from 'node:fs';
    import { getValidToken } from ${JSON.stringify(moduleUrl)};
    await getValidToken(async () => {
      fs.writeFileSync(process.env.ENTERED_FILE, 'entered');
      while (!fs.existsSync(process.env.RELEASE_FILE)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return {
        ok: true,
        text: async () => JSON.stringify({
          access_token: ${JSON.stringify(fakeJwt())},
          refresh_token: 'r2',
          expires_in: 3600,
        }),
      };
    });
  `;
  const logoutScript = `
    import { deleteAuthAsync } from ${JSON.stringify(moduleUrl)};
    await deleteAuthAsync();
  `;
  const env = { ...process.env, KGB_HOME: tmpDir, ENTERED_FILE: enteredFile, RELEASE_FILE: releaseFile };
  const refresh = execFileAsync(process.execPath, ['--input-type=module', '--eval', refreshScript], { env });
  let logout;
  try {
    await waitFor(() => fs.existsSync(enteredFile));
    logout = execFileAsync(process.execPath, ['--input-type=module', '--eval', logoutScript], { env });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.notEqual(loadAuth(), null);
    fs.writeFileSync(releaseFile, 'release');
    await Promise.all([refresh, logout]);
    assert.equal(loadAuth(), null);
  } finally {
    fs.writeFileSync(releaseFile, 'release');
    await Promise.allSettled([refresh, logout].filter(Boolean));
  }
});
