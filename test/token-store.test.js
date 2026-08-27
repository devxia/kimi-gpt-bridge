import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAuth, saveAuth, deleteAuth, getValidToken, authPath, kgbHome } from '../src/token-store.js';

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
  await assert.rejects(getValidToken(async () => assert.fail()), /login/);
});
