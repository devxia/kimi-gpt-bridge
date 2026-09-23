// Semantic decisions use tomllib; the small lexical index only locates edits.
// Never serialize an existing table: comments, spelling and unknown values stay.
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { buildConfigBlock, tomlBasicString } from './models.js';
import { applyCatalogModelPolicy, isRetiredModel } from './model-policy.js';

function parseDocuments(texts) {
  const script = String.raw`
import datetime, json, math, sys, tomllib
def safe(value):
    if isinstance(value, dict): return {k: safe(v) for k, v in value.items()}
    if isinstance(value, list): return [safe(v) for v in value]
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)): return {"$toml_date": str(value)}
    if isinstance(value, float) and not math.isfinite(value): return {"$toml_float": str(value)}
    return value
json.dump([safe(tomllib.loads(text)) for text in json.load(sys.stdin)], sys.stdout)
`;
  const parsed = spawnSync('python3', ['-c', script], {
    input: JSON.stringify(texts), encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (parsed.error || parsed.signal) {
    throw new Error(`Could not inspect config.toml with Python tomllib (timeout or interruption): ${parsed.error?.message ?? parsed.signal}`);
  }
  if (parsed.status !== 0) {
    throw new Error(`Could not parse config.toml with Python tomllib: ${parsed.stderr.trim().split('\n').at(-1)}`);
  }
  return JSON.parse(parsed.stdout);
}

const equalPath = (a, b) => a.length === b.length && a.every((key, i) => key === b[i]);
const prefix = (a, b) => a.length <= b.length && a.every((key, i) => key === b[i]);
const table = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyText = (keys) => keys.map(tomlBasicString).join('.');
const valueText = (value) => Array.isArray(value) ? `[ ${value.map(valueText).join(', ')} ]`
  : typeof value === 'string' ? tomlBasicString(value) : JSON.stringify(value);
const unsafe = (keys) => new Error(`Cannot safely merge config.toml at ${keyText(keys)}; use a regular table or inline table. The original config.toml is unchanged.`);

// This scanner is deliberately independent of TOML validation. Unknown syntax
// fails closed, and a semantic comparison catches any incorrect edit scope.
function indexText(text) {
  const headers = [{ path: [], insert: 0 }];
  const entries = [];
  let pos = 0;
  let scope = [];
  let arrayScope = false;
  const spaces = () => { while (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\r') pos++; };
  const trivia = () => {
    while (pos < text.length) {
      if (/\s/.test(text[pos])) pos++;
      else if (text[pos] === '#') { while (pos < text.length && text[pos] !== '\n') pos++; }
      else break;
    }
  };
  function stringEnd() {
    const quote = text[pos];
    const multi = text.startsWith(quote.repeat(3), pos);
    pos += multi ? 3 : 1;
    while (pos < text.length) {
      if (quote === '"' && text[pos] === '\\') { pos += 2; continue; }
      if (text[pos] === quote) {
        if (!multi) { pos++; return; }
        let count = 0;
        while (text[pos + count] === quote) count++;
        pos += count;
        if (count >= 3) return;
      } else pos++;
    }
    throw unsafe(scope);
  }
  function keys() {
    const result = [];
    while (pos < text.length) {
      spaces();
      const start = pos;
      if (text[pos] === '"' || text[pos] === "'") {
        const quote = text[pos];
        stringEnd();
        let value = text.slice(start + 1, pos - 1);
        if (quote === '"') value = value.replace(/\\(u[\da-fA-F]{4}|U[\da-fA-F]{8}|[btnfr"\\])/g, (_, escape) => {
          if (escape[0] === 'u' || escape[0] === 'U') return String.fromCodePoint(parseInt(escape.slice(1), 16));
          return { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }[escape];
        });
        result.push(value);
      } else {
        while (pos < text.length && /[\w-]/.test(text[pos])) pos++;
        if (pos === start) throw unsafe(scope);
        result.push(text.slice(start, pos));
      }
      spaces();
      if (text[pos] !== '.') return result;
      pos++;
    }
    throw unsafe(scope);
  }
  function value(path, inArray = false) {
    const start = pos;
    if (text[pos] === '"' || text[pos] === "'") stringEnd();
    else if (text[pos] === '[') {
      pos++;
      trivia();
      while (pos < text.length && text[pos] !== ']') {
        value(path, true);
        trivia();
        if (text[pos] === ',') { pos++; trivia(); }
        else if (text[pos] !== ']') throw unsafe(path);
      }
      pos++;
    } else if (text[pos] === '{') {
      const container = { path, start, entries: [], array: inArray || arrayScope };
      pos++;
      trivia();
      while (pos < text.length && text[pos] !== '}') {
        const entryStart = pos;
        const fullPath = [...path, ...keys()];
        if (text[pos++] !== '=') throw unsafe(fullPath);
        spaces();
        const node = value(fullPath, inArray);
        const entry = { path: fullPath, start: entryStart, end: pos, node, container, array: inArray || arrayScope };
        entries.push(entry);
        container.entries.push(entry);
        trivia();
        if (text[pos] === ',') { entry.comma = pos; pos++; trivia(); }
        else if (text[pos] !== '}') throw unsafe(fullPath);
      }
      container.close = pos;
      pos++;
      return { start, end: pos, container };
    } else {
      while (pos < text.length && !['\n', '\r', '#', ',', ']', '}'].includes(text[pos])) pos++;
      while (pos > start && /\s/.test(text[pos - 1])) pos--;
      if (pos === start) throw unsafe(path);
    }
    return { start, end: pos };
  }
  while (pos < text.length) {
    trivia();
    if (pos >= text.length) break;
    const start = pos;
    if (text[pos] === '[') {
      arrayScope = text[pos + 1] === '[';
      pos += arrayScope ? 2 : 1;
      scope = keys();
      const close = arrayScope ? ']]' : ']';
      if (!text.startsWith(close, pos)) throw unsafe(scope);
      pos += close.length;
      while (pos < text.length && text[pos] !== '\n') pos++;
      if (text[pos] === '\n') pos++;
      headers.push({ path: scope, start, end: pos, insert: pos, array: arrayScope });
    } else {
      const path = [...scope, ...keys()];
      if (text[pos++] !== '=') throw unsafe(path);
      spaces();
      const node = value(path);
      spaces();
      if (text[pos] === '#') { while (pos < text.length && text[pos] !== '\n') pos++; }
      if (pos < text.length && text[pos] !== '\n') throw unsafe(path);
      if (text[pos] === '\n') pos++;
      entries.push({ path, start, end: pos, node, array: arrayScope });
    }
  }
  return { headers, entries };
}

function edit(text, start, end, replacement) {
  return text.slice(0, start) + replacement + text.slice(end);
}

function setField(text, path, raw, exists) {
  const { headers, entries } = indexText(text);
  if (headers.some((h) => h.array && prefix(h.path, path)) || entries.some((e) => e.array && prefix(e.path, path))) throw unsafe(path);
  const exact = entries.find((entry) => equalPath(entry.path, path));
  if (exists) {
    if (!exact) throw unsafe(path);
    return edit(text, exact.node.start, exact.node.end, raw);
  }
  // An inline table is closed to outside additions. Insert inside its braces,
  // including when the requested parent is implicit through dotted keys.
  const parent = entries.filter((entry) => prefix(entry.path, path) && entry.path.length < path.length)
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (parent) {
    const container = parent.node.container;
    if (!container || container.array) throw unsafe(path);
    const last = container.entries.at(-1);
    const at = last ? last.node.end : container.start + 1;
    return edit(text, at, at, `${last ? ', ' : ' '}${keyText(path.slice(parent.path.length))} = ${raw}${last ? '' : ' '}`);
  }
  const header = headers.filter((h) => prefix(h.path, path.slice(0, -1)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const at = header.insert;
  const lead = at && text[at - 1] !== '\n' ? newline : '';
  return edit(text, at, at, `${lead}${keyText(path.slice(header.path.length))} = ${raw}${newline}`);
}

function removeTable(text, path) {
  let removedInline = false;
  let index = indexText(text);
  // Dotted fields may share an inline parent with unrelated aliases. Remove
  // one member and its separator at a time, then refresh the source offsets.
  while (true) {
    const member = index.entries.find((e) => e.container && prefix(path, e.path) && !prefix(path, e.container.path));
    if (!member) break;
    const siblings = member.container.entries;
    const i = siblings.indexOf(member);
    if (member.comma !== undefined) {
      text = edit(text, member.start, member.comma + 1, '');
    } else if (i) {
      text = edit(text, siblings[i - 1].comma, member.node.end, '');
    } else {
      text = edit(text, member.start, member.node.end, '');
    }
    removedInline = true;
    index = indexText(text);
  }
  const ranges = [...index.headers, ...index.entries].filter((item) => prefix(path, item.path));
  if (!ranges.length && !removedInline) throw unsafe(path);
  // Nested inline entries are already covered by their outer assignment.
  const outer = ranges.filter((r) => !ranges.some((p) => p !== r && p.start <= r.start && p.end >= r.end));
  for (const range of outer.sort((a, b) => b.start - a.start)) text = edit(text, range.start, range.end, '');
  return text;
}

function checkReferences(config, removed) {
  const references = [['default_model', config.default_model], ['secondary_model.default_model', config.secondary_model?.default_model]];
  if (table(config.secondary_model?.models)) {
    references.push(...Object.keys(config.secondary_model.models).map((alias) => ['secondary_model.models', alias]));
  }
  const invalid = references.filter(([, alias]) => typeof alias === 'string' &&
    (removed.has(alias) || (alias.startsWith('chatgpt/') && (!Object.hasOwn(config.models ?? {}, alias) || isRetiredModel(alias.slice(8))))));
  if (invalid.length) {
    throw new Error(`Refusing to update config.toml because these settings reference missing or retired models in the final merged configuration:\n${invalid.map(([setting, alias]) => `  - ${setting} = ${JSON.stringify(alias)}`).join('\n')}\nThe original config.toml is unchanged. Choose available models and retry.`);
  }
}

export function mergeConfigModels(existing, models, port, { overrideBaseUrl = false } = {}) {
  const block = buildConfigBlock(models.filter((m) => !isRetiredModel(m.slug)).map(applyCatalogModelPolicy), port);
  const [config, defaults] = parseDocuments([existing, block]);
  const expected = structuredClone(config);
  const removed = new Set();
  let result = existing;
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if ((alias.startsWith('chatgpt/') && isRetiredModel(alias.slice(8))) ||
        (table(model) && (alias.startsWith('chatgpt/') || model.provider === 'kimi-gpt-bridge') && isRetiredModel(model.model))) {
      result = removeTable(result, ['models', alias]);
      delete expected.models[alias];
      removed.add(alias);
    }
  }
  // Legacy naming also migrates when this model is absent from the new catalog.
  if (Object.hasOwn(expected.models ?? {}, 'chatgpt/gpt-5.5') && !Object.hasOwn(defaults.models ?? {}, 'chatgpt/gpt-5.5')) {
    defaults.models ??= {};
    defaults.models['chatgpt/gpt-5.5'] = { display_name: 'GPT-5.5 (Legacy)' };
  }
  for (const section of ['providers', 'models']) {
    if (Object.hasOwn(expected, section) && !table(expected[section])) throw unsafe([section]);
    expected[section] ??= {};
    for (const [alias, fields] of Object.entries(defaults[section] ?? {})) {
      if (removed.has(alias)) continue; // never recreate a retired custom mapping
      if (Object.hasOwn(expected[section], alias) && !table(expected[section][alias])) throw unsafe([section, alias]);
      if (!Object.hasOwn(expected[section], alias)) {
        const inlineParent = indexText(result).entries.some((e) => prefix(e.path, [section, alias]));
        if (!inlineParent) {
          const newline = result.includes('\r\n') ? '\r\n' : '\n';
          result += `${result && !result.endsWith('\n') ? newline : ''}${newline}[${keyText([section, alias])}]${newline}`;
        }
      }
      const current = expected[section][alias] ??= {};
      for (const [field, proposed] of Object.entries(fields)) {
        const exists = Object.hasOwn(current, field);
        const replace = (section === 'providers' && field === 'base_url' && overrideBaseUrl) ||
          (section === 'models' && alias === 'chatgpt/gpt-5.5' && field === 'display_name' && current[field] === 'GPT-5.5');
        if (exists && !replace) continue;
        let value = proposed;
        if (field === 'default_effort' && Object.hasOwn(current, 'support_efforts')) {
          const efforts = current.support_efforts;
          if (!Array.isArray(efforts) || !efforts.includes(value)) {
            value = Array.isArray(efforts) ? efforts.find((effort) => typeof effort === 'string' && effort.length) : undefined;
            if (value === undefined) continue;
          }
        }
        if (exists && isDeepStrictEqual(current[field], value)) continue;
        result = setField(result, [section, alias, field], valueText(value), exists);
        current[field] = value;
      }
    }
  }
  checkReferences(expected, removed);
  const [actual] = parseDocuments([result]);
  if (!isDeepStrictEqual(actual, expected)) throw new Error('Cannot safely merge config.toml: edited TOML differs from the intended configuration. The original config.toml is unchanged.');
  // Keep the familiar generated block for first installs only. Subsequent edits
  // use decoded identities, regardless of markers or Kimi's table ordering.
  return existing === '' && isDeepStrictEqual(actual, defaults) ? block : result;
}
