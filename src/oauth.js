// OAuth helpers for the ChatGPT/Codex subscription login flow.
// Ported from pi-mono's openai-codex OAuth implementation.
import crypto from 'node:crypto';

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CALLBACK_HOST = '127.0.0.1';
export const CALLBACK_PORT = 1455; // allow-listed upstream, cannot change
export const DEVICE_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
export const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
export const DEVICE_PAGE_URL = 'https://auth.openai.com/codex/device';
export const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
export const ORIGINATOR = 'kimi-gpt-bridge';

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

// PKCE: verifier = base64url(32 random bytes), challenge = base64url(SHA256(verifier)).
export function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

export function buildAuthorizeUrl({ codeChallenge, state }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', 'openid profile email offline_access');
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', ORIGINATOR);
  return url.toString();
}

// Accepts: full redirect URL, `code#state`, a query string containing `code=`,
// or a bare code. If a state is present it must match expectedState.
export function parseManualInput(input, expectedState) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Empty input — paste the redirect URL or the code.');
  let code;
  let state;
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('Could not parse that as a URL.');
    }
    code = url.searchParams.get('code') ?? undefined;
    state = url.searchParams.get('state') ?? undefined;
  } else if (raw.includes('code=')) {
    const params = new URLSearchParams(raw);
    code = params.get('code') ?? undefined;
    state = params.get('state') ?? undefined;
  } else if (raw.includes('#')) {
    const idx = raw.indexOf('#');
    code = raw.slice(0, idx);
    state = raw.slice(idx + 1) || undefined;
  } else {
    code = raw;
  }
  if (!code) throw new Error('No authorization code found in the pasted input.');
  if (state !== undefined && expectedState !== undefined && state !== expectedState) {
    throw new Error('State mismatch — the pasted value does not belong to this login attempt.');
  }
  return { code, state };
}

function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) throw new Error('Malformed JWT access token.');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

// Extract account metadata from the access token JWT payload.
export function extractAccountInfo(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload['https://api.openai.com/auth'] ?? {};
  const profile = payload['https://api.openai.com/profile'] ?? {};
  return {
    accountId: auth.chatgpt_account_id,
    planType: auth.chatgpt_plan_type,
    email: payload.email ?? profile.email,
  };
}

async function parseJsonBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tokenEndpointError(data, res, what) {
  const code = data?.error?.code ?? (typeof data?.error === 'string' ? data.error : undefined) ?? data?.code;
  const msg = data?.error?.message ?? data?.error_description ?? `HTTP ${res.status}`;
  const err = new Error(`${what} failed: ${msg}`);
  err.status = res.status;
  err.code = code;
  return err;
}

export async function exchangeCode(code, codeVerifier, redirectUri, fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const data = await parseJsonBody(res);
  if (!res.ok) throw tokenEndpointError(data, res, 'Token exchange');
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

export async function refreshTokens(refreshToken, fetchImpl = fetch, signal) {
  const request = fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
    signal,
  });
  const res = signal ? await waitWithSignal(request, signal) : await request;
  const body = parseJsonBody(res);
  const data = signal ? await waitWithSignal(body, signal) : await body;
  if (!res.ok) throw tokenEndpointError(data, res, 'Token refresh');
  return {
    access: data.access_token,
    // Refresh tokens rotate — always persist the new one.
    refresh: data.refresh_token ?? refreshToken,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

export async function requestDeviceCode(fetchImpl = fetch) {
  const res = await fetchImpl(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const data = await parseJsonBody(res);
  if (!res.ok) throw tokenEndpointError(data, res, 'Device code request');
  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    interval: Number(data.interval) || 5,
  };
}

function formatDuration(ms) {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  if (ms % 1000 === 0) {
    const seconds = ms / 1000;
    return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  }
  return `${ms} ${ms === 1 ? 'millisecond' : 'milliseconds'}`;
}

function waitWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

// Polls for device authorization. 403/404 or `deviceauth_authorization_pending`
// means keep polling; `slow_down` increases the interval by 5s. One deadline
// covers sleeps, fetch, and response body reads.
export async function pollDeviceToken({ deviceAuthId, userCode, interval }, { fetchImpl = fetch, timeoutMs = 900_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const timeoutError = new Error(`Device authorization timed out after ${formatDuration(timeoutMs)}.`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(timeoutError), Math.max(0, timeoutMs));
  let currentInterval = interval;
  try {
    while (true) {
      await waitWithSignal(sleep(currentInterval * 1000), controller.signal);
      const res = await waitWithSignal(fetchImpl(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        signal: controller.signal,
      }), controller.signal);
      const data = await waitWithSignal(parseJsonBody(res), controller.signal);
      if (res.ok && data?.authorization_code) {
        return { authorizationCode: data.authorization_code, codeVerifier: data.code_verifier };
      }
      const errCode = data?.error?.code ?? (typeof data?.error === 'string' ? data.error : undefined);
      if (errCode === 'slow_down') {
        currentInterval += 5;
        continue;
      }
      if (res.status === 403 || res.status === 404 || errCode === 'deviceauth_authorization_pending') {
        continue;
      }
      throw tokenEndpointError(data, res, 'Device authorization');
    }
  } catch (err) {
    if (controller.signal.aborted) throw timeoutError;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
