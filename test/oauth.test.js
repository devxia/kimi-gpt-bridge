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
  exchangeCode,
  requestDeviceCode,
  pollDeviceToken,
} from '../src/oauth.js';

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

// What a captive portal / intercepting proxy actually returns: HTTP 200 with
// an HTML page instead of the token JSON.
function htmlResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => '<!DOCTYPE html><html><body>Access denied by network policy</body></html>',
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

// A 2xx carrying an interception page must name the likely cause, not throw a
// TypeError on a null body. AGENTS.md records this exact failure mode: browser
// login succeeds while the terminal path cannot reach OpenAI.
test('token endpoints report a non-JSON 2xx as network interception', async () => {
  const cases = [
    ['Token exchange', () => exchangeCode('code', 'verifier', REDIRECT_URI, async () => htmlResponse())],
    ['Token refresh', () => refreshTokens('refresh-token', async () => htmlResponse())],
    ['Device code request', () => requestDeviceCode(async () => htmlResponse())],
  ];
  for (const [what, call] of cases) {
    await assert.rejects(call, (err) => {
      assert.equal(err.code, 'non_json_response');
      assert.equal(err.status, 200);
      assert.match(err.message, new RegExp(`^${what} failed:`));
      assert.match(err.message, /auth\.openai\.com/);
      assert.match(err.message, /kimi-gpt-bridge proxy/);
      // Must not be the pre-fix TypeError on a null body.
      assert.ok(!(err instanceof TypeError));
      return true;
    });
  }
});

test('token endpoints reject valid JSON that omits the expected field', async () => {
  await assert.rejects(
    exchangeCode('code', 'verifier', REDIRECT_URI, async () => jsonResponse(200, { expires_in: 3600 })),
    (err) => {
      assert.equal(err.code, 'incomplete_response');
      assert.match(err.message, /did not include access_token/);
      return true;
    },
  );
  await assert.rejects(
    refreshTokens('refresh-token', async () => jsonResponse(200, { refresh_token: 'r2' })),
    (err) => {
      assert.equal(err.code, 'incomplete_response');
      assert.match(err.message, /did not include access_token/);
      return true;
    },
  );
  await assert.rejects(
    requestDeviceCode(async () => jsonResponse(200, { device_auth_id: 'd1' })),
    (err) => {
      assert.equal(err.code, 'incomplete_response');
      assert.match(err.message, /did not include user_code/);
      return true;
    },
  );
});

test('a non-JSON error response still reports the upstream status', async () => {
  await assert.rejects(
    refreshTokens('refresh-token', async () => htmlResponse(502)),
    (err) => {
      // !res.ok is handled before the payload check, so this stays a
      // tokenEndpointError carrying the real status.
      assert.equal(err.status, 502);
      assert.match(err.message, /Token refresh failed: HTTP 502/);
      return true;
    },
  );
});

test('exchangeCode sends the PKCE verifier and redirect URI, and rotates in the refresh token', async () => {
  let sent;
  const tokens = await exchangeCode('the-code', 'the-verifier', REDIRECT_URI, async (url, options) => {
    sent = { url, body: new URLSearchParams(options.body) };
    return jsonResponse(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 60 });
  });
  assert.equal(sent.url, 'https://auth.openai.com/oauth/token');
  assert.equal(sent.body.get('grant_type'), 'authorization_code');
  assert.equal(sent.body.get('client_id'), CLIENT_ID);
  assert.equal(sent.body.get('code'), 'the-code');
  assert.equal(sent.body.get('code_verifier'), 'the-verifier');
  assert.equal(sent.body.get('redirect_uri'), REDIRECT_URI);
  assert.equal(tokens.access, 'a1');
  assert.equal(tokens.refresh, 'r1');
  assert.ok(tokens.expires > Date.now());
});

test('requestDeviceCode returns the user code and defaults a missing interval to 5', async () => {
  const dc = await requestDeviceCode(async () => jsonResponse(200, {
    device_auth_id: 'dev-1',
    user_code: 'ABCD-1234',
  }));
  assert.deepEqual(dc, { deviceAuthId: 'dev-1', userCode: 'ABCD-1234', interval: 5 });
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
