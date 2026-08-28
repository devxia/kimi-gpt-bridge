import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  CLIENT_ID,
  REDIRECT_URI,
  generatePKCE,
  generateState,
  buildAuthorizeUrl,
  parseManualInput,
  extractAccountInfo,
  refreshTokens,
  pollDeviceToken,
} from '../src/oauth.js';

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

test('authorize URL contains all required parameters', () => {
  const url = new URL(buildAuthorizeUrl({ codeChallenge: 'cc123', state: 'st456' }));
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access');
  assert.equal(url.searchParams.get('code_challenge'), 'cc123');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'st456');
  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(url.searchParams.get('originator'), 'kimi-gpt-bridge');
});

test('PKCE challenge is base64url(SHA256(verifier))', () => {
  const { verifier, challenge } = generatePKCE();
  const expected = crypto.createHash('sha256').update(verifier).digest().toString('base64url');
  assert.equal(challenge, expected);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
});

test('state is 16 random bytes as hex', () => {
  assert.match(generateState(), /^[0-9a-f]{32}$/);
});

test('manual paste parser: full redirect URL', () => {
  const { code } = parseManualInput('http://localhost:1455/auth/callback?code=abc123&state=st', 'st');
  assert.equal(code, 'abc123');
});

test('manual paste parser: code#state', () => {
  const { code, state } = parseManualInput('abc123#st', 'st');
  assert.equal(code, 'abc123');
  assert.equal(state, 'st');
});

test('manual paste parser: query string containing code=', () => {
  const { code } = parseManualInput('code=zzz&state=st', 'st');
  assert.equal(code, 'zzz');
});

test('manual paste parser: bare code', () => {
  const { code } = parseManualInput('  bare-code-123  ', 'st');
  assert.equal(code, 'bare-code-123');
});

test('manual paste parser: state mismatch is an error', () => {
  assert.throws(() => parseManualInput('http://localhost:1455/auth/callback?code=a&state=WRONG', 'st'), /state mismatch/i);
  assert.throws(() => parseManualInput('a#WRONG', 'st'), /state mismatch/i);
});

function unsignedJwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(payload)}.`;
}

test('JWT account info extraction: accountId, planType, email', () => {
  const token = unsignedJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_abc', chatgpt_plan_type: 'pro' },
    email: 'user@example.com',
  });
  assert.deepEqual(extractAccountInfo(token), {
    accountId: 'acct_abc',
    planType: 'pro',
    email: 'user@example.com',
  });
});

test('JWT account info extraction: email from profile claim fallback', () => {
  const token = unsignedJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_x', chatgpt_plan_type: 'plus' },
    'https://api.openai.com/profile': { email: 'p@example.com' },
  });
  const info = extractAccountInfo(token);
  assert.equal(info.email, 'p@example.com');
  assert.equal(info.accountId, 'acct_x');
});

test('refreshTokens passes AbortSignal and escapes a fetch that ignores it', async () => {
  const controller = new AbortController();
  const reason = new DOMException('cancelled', 'AbortError');
  const refresh = refreshTokens('refresh-token', async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    return new Promise(() => {});
  }, controller.signal);
  controller.abort(reason);
  await assert.rejects(refresh, (err) => err === reason);
});

test('refreshTokens cancellation escapes a hanging response body read', async () => {
  const controller = new AbortController();
  const reason = new DOMException('cancelled body', 'AbortError');
  const refresh = refreshTokens('refresh-token', async () => ({
    ok: true,
    text: async () => new Promise(() => {}),
  }), controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(refresh, (err) => err === reason);
});

test('device polling retries pending responses and returns authorization data', async () => {
  const responses = [
    jsonResponse(403, { error: { code: 'deviceauth_authorization_pending' } }),
    jsonResponse(200, { authorization_code: 'auth-code', code_verifier: 'verifier' }),
  ];
  const sleeps = [];
  const result = await pollDeviceToken(
    { deviceAuthId: 'device-id', userCode: 'user-code', interval: 2 },
    {
      fetchImpl: async (_url, options) => {
        assert.ok(options.signal instanceof AbortSignal);
        return responses.shift();
      },
      timeoutMs: 1_000,
      sleep: async (ms) => sleeps.push(ms),
    },
  );
  assert.deepEqual(result, { authorizationCode: 'auth-code', codeVerifier: 'verifier' });
  assert.deepEqual(sleeps, [2_000, 2_000]);
});

test('device polling slow_down increases subsequent intervals by five seconds', async () => {
  const responses = [
    jsonResponse(400, { error: 'slow_down' }),
    jsonResponse(200, { authorization_code: 'auth-code', code_verifier: 'verifier' }),
  ];
  const sleeps = [];
  await pollDeviceToken(
    { deviceAuthId: 'device-id', userCode: 'user-code', interval: 3 },
    {
      fetchImpl: async () => responses.shift(),
      timeoutMs: 1_000,
      sleep: async (ms) => sleeps.push(ms),
    },
  );
  assert.deepEqual(sleeps, [3_000, 8_000]);
});

test('device polling deadline aborts and escapes a hanging fetch', async () => {
  let signal;
  const poll = pollDeviceToken(
    { deviceAuthId: 'device-id', userCode: 'user-code', interval: 0 },
    {
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
      timeoutMs: 20,
      sleep: async () => {},
    },
  );
  await assert.rejects(poll, /timed out after 20 milliseconds/);
  assert.equal(signal.aborted, true);
});

test('device polling deadline aborts and escapes a hanging response body read', async () => {
  let signal;
  const poll = pollDeviceToken(
    { deviceAuthId: 'device-id', userCode: 'user-code', interval: 0 },
    {
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return {
          ok: false,
          status: 403,
          text: async () => new Promise(() => {}),
        };
      },
      timeoutMs: 20,
      sleep: async () => {},
    },
  );
  await assert.rejects(poll, /timed out after 20 milliseconds/);
  assert.equal(signal.aborted, true);
});
