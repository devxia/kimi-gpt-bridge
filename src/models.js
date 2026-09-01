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

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function catalogPriority(model) {
  return typeof model.priority === 'number' && Number.isFinite(model.priority)
    ? model.priority
    : Number.MAX_SAFE_INTEGER;
}

// Filters the raw catalog down to user-selectable models and normalizes the
// field names. `planType` (e.g. "plus") gates on available_in_plans; when the
// plan is unknown the gate is skipped rather than hiding everything.
export function selectModels(catalog, planType) {
  const seenSlugs = new Set();
  return catalog
    .filter(
      (m) =>
        m &&
        nonEmptyString(m.slug) &&
        m.visibility === 'list' &&
        m.supported_in_api !== false &&
        (!Array.isArray(m.available_in_plans) ||
          m.available_in_plans.length === 0 ||
          !planType ||
          m.available_in_plans.includes(planType)),
    )
    .sort((a, b) => catalogPriority(a) - catalogPriority(b))
    .filter((m) => {
      if (seenSlugs.has(m.slug)) return false;
      seenSlugs.add(m.slug);
      return true;
    })
    .map((m) => {
      const efforts = [];
      if (Array.isArray(m.supported_reasoning_levels)) {
        for (const level of m.supported_reasoning_levels) {
          const effort = level?.effort;
          if (nonEmptyString(effort) && !EXCLUDED_EFFORTS.has(effort) && !efforts.includes(effort)) {
            efforts.push(effort);
          }
        }
      }
      let defaultEffort = nonEmptyString(m.default_reasoning_level) ? m.default_reasoning_level : null;
      if (defaultEffort && EXCLUDED_EFFORTS.has(defaultEffort)) {
        defaultEffort = efforts.includes('medium') ? 'medium' : (efforts[0] ?? null);
      }
      return {
        slug: m.slug,
        displayName: typeof m.display_name === 'string' ? m.display_name : m.slug,
        description: typeof m.description === 'string' ? m.description : '',
        // Use context_window — the window the Codex subscription path actually
        // accepts (what Codex CLI and pi both use). max_context_window is the
        // underlying model's hard capacity and is NOT honored on this path.
        contextWindow: Number.isInteger(m.context_window) && m.context_window > 0 ? m.context_window : null,
        defaultEffort,
        efforts,
      };
    });
}

// TOML basic strings can represent every Unicode scalar value. Reject lone JS
// surrogates rather than emitting an escape that a conforming parser rejects.
function tomlBasicString(value) {
  if (typeof value !== 'string') throw new TypeError('TOML string values must be strings.');
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new TypeError('TOML strings cannot contain lone surrogates.');
      out += value[i] + value[i + 1];
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('TOML strings cannot contain lone surrogates.');
    } else if (value[i] === '"') {
      out += '\\"';
    } else if (value[i] === '\\') {
      out += '\\\\';
    } else if (value[i] === '\b') {
      out += '\\b';
    } else if (value[i] === '\t') {
      out += '\\t';
    } else if (value[i] === '\n') {
      out += '\\n';
    } else if (value[i] === '\f') {
      out += '\\f';
    } else if (value[i] === '\r') {
      out += '\\r';
    } else if (code <= 0x1f || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`;
    } else {
      out += value[i];
    }
  }
  return `${out}"`;
}

// Full marker block for Kimi Code's config.toml: the provider table plus one
// [models."chatgpt/<slug>"] entry per model.
export function buildConfigBlock(models, port) {
  const lines = [
    MARKER_START,
    '[providers.kimi-gpt-bridge]',
    'type = "openai"',
    `base_url = ${tomlBasicString(`http://127.0.0.1:${String(port)}/v1`)}`,
    'api_key = "kimi-gpt-bridge"',
    '',
  ];
  const seenSlugs = new Set();
  for (const m of models) {
    if (!nonEmptyString(m?.slug)) throw new TypeError('Model slugs must be non-empty strings.');
    if (seenSlugs.has(m.slug)) continue;
    seenSlugs.add(m.slug);
    lines.push(`[models.${tomlBasicString(`chatgpt/${m.slug}`)}]`);
    lines.push('provider = "kimi-gpt-bridge"');
    lines.push(`model = ${tomlBasicString(m.slug)}`);
    if (Number.isInteger(m.contextWindow) && m.contextWindow > 0) {
      lines.push(`max_context_size = ${m.contextWindow}`);
    }
    lines.push('capabilities = [ "thinking", "tool_use", "image_in" ]');
    const efforts = Array.isArray(m.efforts) ? m.efforts.filter(nonEmptyString) : [];
    if (efforts.length) lines.push(`support_efforts = [ ${efforts.map(tomlBasicString).join(', ')} ]`);
    if (nonEmptyString(m.defaultEffort)) lines.push(`default_effort = ${tomlBasicString(m.defaultEffort)}`);
    lines.push('');
  }
  return `${lines.join('\n')}${MARKER_END}\n`;
}

function skipTomlWhitespace(text, index) {
  while (text[index] === ' ' || text[index] === '\t') index += 1;
  return index;
}

function parseTomlQuotedKey(text, index) {
  const quote = text[index];
  let value = '';
  for (let i = index + 1; i < text.length; i += 1) {
    const char = text[i];
    const code = text.charCodeAt(i);
    if (char === quote) return { value, end: i + 1 };
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return null;
    if (quote === "'" || char !== '\\') {
      value += char;
      continue;
    }
    const escape = text[++i];
    const escapes = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (Object.hasOwn(escapes, escape)) {
      value += escapes[escape];
      continue;
    }
    const digits = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
    if (!digits) return null;
    const hex = text.slice(i + 1, i + 1 + digits);
    if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(hex)) return null;
    const point = Number.parseInt(hex, 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
    value += String.fromCodePoint(point);
    i += digits;
  }
  return null;
}

function parseTomlDottedKey(text, index) {
  const pathParts = [];
  let cursor = skipTomlWhitespace(text, index);
  while (cursor < text.length) {
    let key;
    if (text[cursor] === '"' || text[cursor] === "'") {
      const parsed = parseTomlQuotedKey(text, cursor);
      if (!parsed) return null;
      key = parsed.value;
      cursor = parsed.end;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(cursor));
      if (!match) return null;
      key = match[0];
      cursor += key.length;
    }
    pathParts.push(key);
    cursor = skipTomlWhitespace(text, cursor);
    if (text[cursor] !== '.') return { pathParts, end: cursor };
    cursor = skipTomlWhitespace(text, cursor + 1);
  }
  return null;
}

// Parses a single TOML table header into its decoded dotted-key identity.
// Invalid headers return null and therefore cannot accidentally end a strip.
function parseTomlTableHeader(line) {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  let cursor = skipTomlWhitespace(text, 0);
  if (text[cursor] !== '[') return null;
  const arrayTable = text[cursor + 1] === '[';
  cursor += arrayTable ? 2 : 1;
  const parsed = parseTomlDottedKey(text, cursor);
  if (!parsed) return null;
  cursor = parsed.end;
  const close = arrayTable ? ']]' : ']';
  if (!text.startsWith(close, cursor)) return null;
  cursor = skipTomlWhitespace(text, cursor + close.length);
  if (cursor < text.length && text[cursor] !== '#') return null;
  return parsed.pathParts;
}

function isBridgeTable(pathParts) {
  return (
    (pathParts[0] === 'providers' && pathParts[1] === 'kimi-gpt-bridge') ||
    (pathParts[0] === 'models' && pathParts[1]?.startsWith('chatgpt/'))
  );
}

function tomlMultilineStateAfterLine(line, state) {
  let cursor = 0;
  while (cursor < line.length) {
    if (state) {
      const close = line.indexOf(state, cursor);
      if (close < 0) return state;
      if (state === '"""') {
        let backslashes = 0;
        for (let i = close - 1; i >= 0 && line[i] === '\\'; i -= 1) backslashes += 1;
        if (backslashes % 2) {
          cursor = close + 1;
          continue;
        }
      }
      state = null;
      cursor = close + 3;
      continue;
    }
    const char = line[cursor];
    if (char === '#') return null;
    if (char !== '"' && char !== "'") {
      cursor += 1;
      continue;
    }
    const delimiter = char.repeat(3);
    if (line.startsWith(delimiter, cursor)) {
      state = delimiter;
      cursor += 3;
      continue;
    }
    cursor += 1;
    while (cursor < line.length) {
      if (line[cursor] === char) {
        cursor += 1;
        break;
      }
      if (char === '"' && line[cursor] === '\\') cursor += 1;
      cursor += 1;
    }
  }
  return state;
}

function tomlValueStateAfterLine(line, index, previous = null) {
  const state = previous
    ? { ...previous }
    : { multiline: null, squareDepth: 0, braceDepth: 0 };
  let cursor = index;
  while (cursor < line.length) {
    if (state.multiline) {
      const close = line.indexOf(state.multiline, cursor);
      if (close < 0) return state;
      if (state.multiline === '"""') {
        let backslashes = 0;
        for (let i = close - 1; i >= 0 && line[i] === '\\'; i -= 1) backslashes += 1;
        if (backslashes % 2) {
          cursor = close + 1;
          continue;
        }
      }
      state.multiline = null;
      cursor = close + 3;
      continue;
    }
    const char = line[cursor];
    if (char === '#') break;
    if (char === '"' || char === "'") {
      const delimiter = char.repeat(3);
      if (line.startsWith(delimiter, cursor)) {
        state.multiline = delimiter;
        cursor += 3;
        continue;
      }
      cursor += 1;
      while (cursor < line.length) {
        if (line[cursor] === char) {
          cursor += 1;
          break;
        }
        if (char === '"' && line[cursor] === '\\') cursor += 1;
        cursor += 1;
      }
      continue;
    }
    if (char === '[') state.squareDepth += 1;
    else if (char === ']') state.squareDepth = Math.max(0, state.squareDepth - 1);
    else if (char === '{') state.braceDepth += 1;
    else if (char === '}') state.braceDepth = Math.max(0, state.braceDepth - 1);
    cursor += 1;
  }
  return state;
}

function tomlValueContinues(state) {
  return state.multiline !== null || state.squareDepth > 0 || state.braceDepth > 0;
}

// Removes every bridge-owned table, top-level dotted-key assignment, and marker
// comment from config.toml text. Assignments relative to another table are kept.
export function stripBridgeTables(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let tablePath = [];
  let skippingTable = false;
  let skippingAssignment = null;
  let multiline = null;
  for (const line of lines) {
    const startsInsideMultiline = multiline !== null;
    multiline = tomlMultilineStateAfterLine(line, multiline);
    if (skippingAssignment) {
      skippingAssignment = tomlValueStateAfterLine(line, 0, skippingAssignment);
      if (!tomlValueContinues(skippingAssignment)) skippingAssignment = null;
      continue;
    }
    if (!startsInsideMultiline) {
      const trimmed = line.trim();
      if (trimmed === MARKER_START || trimmed === MARKER_END) continue;
      const header = parseTomlTableHeader(line);
      if (header) {
        tablePath = header;
        skippingTable = isBridgeTable(header);
        if (skippingTable) continue;
      } else if (!skippingTable && tablePath.length === 0) {
        const assignment = parseTomlAssignment(line);
        if (assignment && isBridgeTable(assignment.pathParts)) {
          const valueState = tomlValueStateAfterLine(line, assignment.valueStart);
          if (tomlValueContinues(valueState)) skippingAssignment = valueState;
          continue;
        }
      }
    }
    if (!skippingTable) out.push(line);
  }
  return out.join('\n');
}

function parseTomlAssignment(line) {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  const parsed = parseTomlDottedKey(text, 0);
  if (!parsed) return null;
  const cursor = skipTomlWhitespace(text, parsed.end);
  if (text[cursor] !== '=') return null;
  return { pathParts: parsed.pathParts, text, valueStart: skipTomlWhitespace(text, cursor + 1) };
}

function tomlStringSuffixIsValid(text, index) {
  const cursor = skipTomlWhitespace(text, index);
  return cursor === text.length || text[cursor] === '#' || text[cursor] === '\n';
}

function parseTomlMultilineStringValue(text, index) {
  const quote = text[index];
  const delimiter = quote.repeat(3);
  if (!text.startsWith(delimiter, index)) return null;
  let cursor = index + 3;
  let value = '';
  if (text[cursor] === '\n') cursor += 1;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === quote) {
      let count = 1;
      while (text[cursor + count] === quote) count += 1;
      if (count >= 3) {
        if (count > 5) return null;
        value += quote.repeat(count - 3);
        cursor += count;
        return tomlStringSuffixIsValid(text, cursor) ? value : null;
      }
      value += quote.repeat(count);
      cursor += count;
      continue;
    }
    const code = text.charCodeAt(cursor);
    if ((code < 0x20 && char !== '\t' && char !== '\n') || code === 0x7f) return null;
    if (quote === "'" || char !== '\\') {
      value += char;
      cursor += 1;
      continue;
    }
    let whitespace = cursor + 1;
    while (text[whitespace] === ' ' || text[whitespace] === '\t') whitespace += 1;
    if (text[whitespace] === '\n') {
      cursor = whitespace + 1;
      while (text[cursor] === ' ' || text[cursor] === '\t' || text[cursor] === '\n') cursor += 1;
      continue;
    }
    const escape = text[cursor + 1];
    const escapes = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (Object.hasOwn(escapes, escape)) {
      value += escapes[escape];
      cursor += 2;
      continue;
    }
    const digits = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
    if (!digits) return null;
    const hex = text.slice(cursor + 2, cursor + 2 + digits);
    if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(hex)) return null;
    const point = Number.parseInt(hex, 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
    value += String.fromCodePoint(point);
    cursor += digits + 2;
  }
  return null;
}

function parseTomlStringValue(text, index) {
  if (text[index] !== '"' && text[index] !== "'") return null;
  if (text.startsWith(text[index].repeat(3), index)) {
    return parseTomlMultilineStringValue(text, index);
  }
  const parsed = parseTomlQuotedKey(text, index);
  if (!parsed || !tomlStringSuffixIsValid(text, parsed.end)) return null;
  return parsed.value;
}

function parseTomlAssignmentStringValue(lines, lineIndex, assignment) {
  const firstLineValue = assignment.text.slice(assignment.valueStart);
  if (firstLineValue.startsWith('"""') || firstLineValue.startsWith("'''")) {
    return parseTomlStringValue([firstLineValue, ...lines.slice(lineIndex + 1)].join('\n'), 0);
  }
  return parseTomlStringValue(assignment.text, assignment.valueStart);
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
