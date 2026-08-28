// Upstream calls to ChatGPT's backend Codex Responses endpoint.
import fs from 'node:fs';
import os from 'node:os';
import { getValidToken, refreshNow } from './token-store.js';

export const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export function upstreamBase() {
  return process.env.KGB_UPSTREAM_BASE || 'https://chatgpt.com/backend-api';
}

export function upstreamHeaders(auth, sessionId, version = VERSION) {
  return {
    authorization: `Bearer ${auth.access}`,
    'chatgpt-account-id': auth.accountId ?? '',
    originator: 'kimi-gpt-bridge',
    'user-agent': `kimi-gpt-bridge/${version} (${process.platform} ${os.release()}; ${process.arch})`,
    'openai-beta': 'responses=experimental',
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'session-id': sessionId,
    'x-client-request-id': sessionId,
  };
}

const USAGE_LIMIT_TYPES = new Set(['usage_limit_reached', 'usage_not_included', 'rate_limit_exceeded']);

function humanizeReset(resetsAt) {
  const ms = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
  const mins = Math.max(1, Math.round((ms - Date.now()) / 60_000));
  return `try again in ~${mins} min`;
}

// Builds an informative Error from a non-2xx upstream response.
export async function upstreamError(res) {
  const text = await res.text().catch(() => '');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const e = data?.error ?? null;
  const nested = e && typeof e === 'object' ? e : null;
  let message = nested?.message ?? data?.message ?? data?.detail ?? (text || `HTTP ${res.status}`);
  const type = nested?.type ?? (typeof e === 'string' ? e : null) ?? data?.type ?? null;
  const code = nested?.code ?? data?.code ?? null;

  const limitFields = [nested?.type, nested?.code, data?.type, data?.code];
  if (res.status === 429 && limitFields.some((value) => USAGE_LIMIT_TYPES.has(value))) {
    const planType = nested?.plan_type ?? data?.plan_type;
    const plan = planType ? ` (plan: ${planType})` : '';
    const resetsAt = nested?.resets_at ?? data?.resets_at;
    const reset = resetsAt != null ? ` — ${humanizeReset(resetsAt)}` : '';
    message = `${message}${plan}${reset}`;
  }

  const err = new Error(message);
  err.status = res.status;
  err.type = type ?? 'upstream_error';
  err.code = code;
  return err;
}

async function postResponses(body, auth, sessionId, fetchImpl, signal) {
  return fetchImpl(`${upstreamBase()}/codex/responses`, {
    method: 'POST',
    headers: upstreamHeaders(auth, sessionId),
    body: JSON.stringify(body),
    signal,
  });
}

// POSTs a Responses body upstream. On HTTP 401 the token is force-refreshed
// and the request retried exactly once.
export async function callUpstream(body, { sessionId, fetchImpl = fetch, signal } = {}) {
  let auth = await getValidToken(fetchImpl, signal);
  let res = await postResponses(body, auth, sessionId, fetchImpl, signal);
  if (res.status === 401) {
    auth = await refreshNow(fetchImpl, auth, signal);
    res = await postResponses(body, auth, sessionId, fetchImpl, signal);
  }
  if (!res.ok) throw await upstreamError(res);
  return res;
}
