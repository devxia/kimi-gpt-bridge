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
} from '../src/oauth.js';

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
