// Model catalog: fetch the live list from ChatGPT's Codex backend, select the
// models usable for the account's plan, render the Kimi Code config block, and
// cache the id list for the server's /v1/models route.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { upstreamBase, upstreamHeaders, upstreamError } from './upstream.js';
import { kgbHome, getValidToken } from './token-store.js';

export const MODELS_CLIENT_VERSION = '0.146.0';

export const MARKER_START = '# >>> kimi-gpt-bridge >>>';
export const MARKER_END = '# <<< kimi-gpt-bridge <<<';

// Used when the live catalog cannot be fetched (offline, not logged in, or the
// endpoint changes). Keep in sync with the current ChatGPT generation.
export const STATIC_FALLBACK_MODELS = [
  {
    slug: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    description: '',
    contextWindow: 272000,
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    slug: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: '',
    contextWindow: 272000,
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    slug: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    description: '',
    contextWindow: 272000,
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
];

// GET /codex/models with the standard auth headers; returns the raw catalog
// (array of upstream model objects).
export async function fetchModelCatalog(auth, fetchImpl = fetch) {
  const res = await fetchImpl(`${upstreamBase()}/codex/models?client_version=${MODELS_CLIENT_VERSION}`, {
    headers: upstreamHeaders(auth, crypto.randomUUID()),
  });
  if (!res.ok) throw await upstreamError(res);
  const data = await res.json();
  if (!Array.isArray(data?.models)) throw new Error('Unexpected catalog response shape (missing "models" array).');
  return data.models;
}

// Reasoning tiers we never expose: "ultra" (task-delegation mode, Codex-only)
// and off-style values — excluded from config and from every endpoint refresh.
const EXCLUDED_EFFORTS = new Set(['ultra', 'off', 'none']);

// Filters the raw catalog down to user-selectable models and normalizes the
// field names. `planType` (e.g. "plus") gates on available_in_plans; when the
// plan is unknown the gate is skipped rather than hiding everything.
export function selectModels(catalog, planType) {
  return catalog
    .filter(
      (m) =>
        m &&
        typeof m.slug === 'string' &&
        m.visibility === 'list' &&
        m.supported_in_api !== false &&
        (!Array.isArray(m.available_in_plans) ||
          m.available_in_plans.length === 0 ||
          !planType ||
          m.available_in_plans.includes(planType)),
    )
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
    .map((m) => {
      const efforts = Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((l) => l?.effort).filter((e) => e && !EXCLUDED_EFFORTS.has(e))
        : [];
      let defaultEffort = m.default_reasoning_level ?? null;
      if (defaultEffort && EXCLUDED_EFFORTS.has(defaultEffort)) {
        defaultEffort = efforts.includes('medium') ? 'medium' : (efforts[0] ?? null);
      }
      return {
        slug: m.slug,
        displayName: m.display_name ?? m.slug,
        description: m.description ?? '',
        // Use context_window — the window the Codex subscription path actually
        // accepts (what Codex CLI and pi both use). max_context_window is the
        // underlying model's hard capacity and is NOT honored on this path.
        contextWindow: typeof m.context_window === 'number' ? m.context_window : null,
        defaultEffort,
        efforts,
      };
    });
}

// Full marker block for Kimi Code's config.toml: the provider table plus one
// [models."chatgpt/<slug>"] entry per model.
export function buildConfigBlock(models, port) {
  const lines = [
    MARKER_START,
    '[providers.kimi-gpt-bridge]',
    'type = "openai"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'api_key = "kimi-gpt-bridge"',
    '',
  ];
  for (const m of models) {
    lines.push(`[models."chatgpt/${m.slug}"]`);
    lines.push('provider = "kimi-gpt-bridge"');
    lines.push(`model = "${m.slug}"`);
    if (m.contextWindow) lines.push(`max_context_size = ${m.contextWindow}`);
    lines.push('capabilities = [ "thinking", "tool_use", "image_in" ]');
    if (m.efforts?.length) lines.push(`support_efforts = [ ${m.efforts.map((e) => `"${e}"`).join(', ')} ]`);
    if (m.defaultEffort) lines.push(`default_effort = "${m.defaultEffort}"`);
    lines.push('');
  }
  return `${lines.join('\n')}${MARKER_END}\n`;
}

const BLOCK_RE = /# >>> kimi-gpt-bridge >>>[\s\S]*?# <<< kimi-gpt-bridge <<<\n?/;

// Matches our provider table (incl. sub-tables like .env) and any
// [models."chatgpt/<slug>"] entries (incl. .overrides), marked or NOT.
// Kimi Code re-serializes config.toml on some writes and hoists our tables to
// its canonical providers/models sections, dropping the marker comments — so
// identity, not the markers, is the reliable way to find our entries.
const BRIDGE_PROVIDER_HEADER = /^\s*\[providers\.(?:"kimi-gpt-bridge"|kimi-gpt-bridge)(\.[^\]]+)?\]\s*$/;
const BRIDGE_MODEL_HEADER = /^\s*\[models\."chatgpt\/[^"]+"(\.[^\]]+)?\]\s*$/;

// Removes every bridge-owned table and marker comment from config.toml text,
// wherever they appear. Other providers/models are preserved untouched.
export function stripBridgeTables(text) {
  const isTableHeader = (l) => /^\s*\[/.test(l);
  const lines = String(text ?? '').split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (line.includes(MARKER_START) || line.includes(MARKER_END)) continue;
    if (isTableHeader(line)) {
      skipping = BRIDGE_PROVIDER_HEADER.test(line) || BRIDGE_MODEL_HEADER.test(line);
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// Idempotent install of the marker block: strip every existing bridge entry
// (marked or hoisted-out-of-markers by Kimi Code rewrites), then append the
// fresh block at the END so it stays valid TOML.
export function upsertConfigBlock(existing, block) {
  const stripped = stripBridgeTables(existing).trimEnd();
  return stripped ? `${stripped}\n\n${block}` : block;
}

export const MODELS_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

export function modelsCachePath() {
  return path.join(kgbHome(), 'models-cache.json');
}

// Persisted by `models sync` (and getModelIds) so a running server can serve
// the fresh list; shape: { fetchedAt, ids }.
export function saveModelsCache(ids) {
  try {
    fs.mkdirSync(kgbHome(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(modelsCachePath(), JSON.stringify({ fetchedAt: Date.now(), ids }), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

let memoryCache = null; // { fetchedAt, ids }

// Test helper: drop the in-memory cache (the file cache lives under KGB_HOME,
// which tests point at a temp dir).
export function clearModelCache() {
  memoryCache = null;
}

// Resolves the model id list for /v1/models: in-memory cache → file cache
// (4h TTL) → live fetch → static fallback.
export async function getModelIds({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (memoryCache && now - memoryCache.fetchedAt < MODELS_CACHE_TTL_MS) return memoryCache.ids;
  try {
    const data = JSON.parse(fs.readFileSync(modelsCachePath(), 'utf8'));
    if (Array.isArray(data?.ids) && data.ids.length && now - data.fetchedAt < MODELS_CACHE_TTL_MS) {
      memoryCache = { fetchedAt: data.fetchedAt, ids: data.ids };
      return data.ids;
    }
  } catch {
    /* no usable file cache */
  }
  try {
    const auth = await getValidToken(fetchImpl);
    const models = selectModels(await fetchModelCatalog(auth, fetchImpl), auth.planType);
    if (models.length) {
      const ids = models.map((m) => m.slug);
      memoryCache = { fetchedAt: now, ids };
      saveModelsCache(ids);
      return ids;
    }
  } catch {
    /* fall through to the static list */
  }
  return STATIC_FALLBACK_MODELS.map((m) => m.slug);
}
