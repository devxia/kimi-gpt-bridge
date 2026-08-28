import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MARKER_START,
  MARKER_END,
  STATIC_FALLBACK_MODELS,
  fetchModelCatalog,
  selectModels,
  buildConfigBlock,
  upsertConfigBlock,
  stripBridgeTables,
  findChatgptModelReferences,
  clearModelCache,
  modelsCachePath,
} from '../src/models.js';
import { saveAuth } from '../src/token-store.js';
import { createBridgeServer } from '../src/server.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function parseToml(text) {
  const parsed = spawnSync(
    'python3',
    ['-c', 'import json, sys, tomllib; json.dump(tomllib.loads(sys.stdin.read()), sys.stdout)'],
    { input: text, encoding: 'utf8' },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}

const CATALOG = [
  {
    slug: 'gpt-hidden',
    visibility: 'hide',
    supported_in_api: true,
    available_in_plans: ['plus'],
    priority: 0,
  },
  {
    slug: 'gpt-not-api',
    visibility: 'list',
    supported_in_api: false,
    priority: 1,
  },
  {
    slug: 'gpt-pro-only',
    visibility: 'list',
    supported_in_api: true,
    available_in_plans: ['pro'],
    priority: 2,
  },
  {
    slug: 'gpt-b',
    display_name: 'GPT B',
    description: 'second',
    visibility: 'list',
    supported_in_api: true,
    available_in_plans: ['plus', 'pro'],
    context_window: 128000,
    default_reasoning_level: 'high',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }, { effort: 'off' }],
    priority: 20,
  },
  {
    slug: 'gpt-a',
    display_name: 'GPT A',
    visibility: 'list',
    supported_in_api: true,
    available_in_plans: [],
    context_window: 272000,
    max_context_window: 872000,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'xhigh' }],
    priority: 10,
  },
];

test('selectModels filters by visibility/api/plan and sorts by priority', () => {
  const models = selectModels(CATALOG, 'plus');
  assert.deepEqual(
    models.map((m) => m.slug),
    ['gpt-a', 'gpt-b'],
  );
  // context_window wins; max_context_window (the model's hard capacity) is
  // deliberately ignored, matching pi / Codex CLI behavior.
  assert.deepEqual(models[0], {
    slug: 'gpt-a',
    displayName: 'GPT A',
    description: '',
    contextWindow: 272000,
    defaultEffort: 'medium',
    efforts: ['medium', 'xhigh'],
  });
  assert.equal(models[1].defaultEffort, 'high');
  // ultra / off tiers are always excluded, including from endpoint refreshes.
  assert.deepEqual(models[1].efforts, ['low', 'high']);
  // Pro plan additionally includes the pro-only model.
  assert.deepEqual(
    selectModels(CATALOG, 'pro').map((m) => m.slug),
    ['gpt-pro-only', 'gpt-a', 'gpt-b'],
  );
  // Unknown plan: the plan gate is skipped rather than hiding everything.
  assert.deepEqual(
    selectModels(CATALOG, undefined).map((m) => m.slug),
    ['gpt-pro-only', 'gpt-a', 'gpt-b'],
  );
});

test('selectModels rejects malformed strings and deduplicates catalog slugs and efforts', () => {
  const models = selectModels(
    [
      { slug: '', visibility: 'list', supported_in_api: true, priority: 0 },
      { slug: 42, visibility: 'list', supported_in_api: true, priority: 0 },
      {
        slug: 'same',
        display_name: 42,
        description: {},
        visibility: 'list',
        supported_in_api: true,
        context_window: -1,
        default_reasoning_level: {},
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'low' }, { effort: 42 }],
        priority: 1,
      },
      { slug: 'same', visibility: 'list', supported_in_api: true, priority: 2 },
    ],
    'plus',
  );
  assert.deepEqual(models, [
    {
      slug: 'same',
      displayName: 'same',
      description: '',
      contextWindow: null,
      defaultEffort: null,
      efforts: ['low'],
    },
  ]);
});

test('buildConfigBlock renders markers, provider table and per-model TOML', () => {
  const models = selectModels(CATALOG, 'plus');
  const block = buildConfigBlock(models, 1456);
  assert.ok(block.startsWith(`${MARKER_START}\n`));
  assert.ok(block.endsWith(`${MARKER_END}\n`));
  assert.match(block, /\[providers\.kimi-gpt-bridge\]\ntype = "openai"\nbase_url = "http:\/\/127\.0\.0\.1:1456\/v1"\napi_key = "kimi-gpt-bridge"/);
  assert.match(block, /\[models\."chatgpt\/gpt-a"\]\nprovider = "kimi-gpt-bridge"\nmodel = "gpt-a"\nmax_context_size = 272000\ncapabilities = \[ "thinking", "tool_use", "image_in" \]\nsupport_efforts = \[ "medium", "xhigh" \]\ndefault_effort = "medium"/);
  // max_context_window is never emitted as max_input_size / max_context_size.
  assert.ok(!block.includes('max_input_size'));
  assert.ok(!block.includes('872000'));
  // gpt-a (priority 10) comes before gpt-b (priority 20).
  assert.ok(block.indexOf('chatgpt/gpt-a') < block.indexOf('chatgpt/gpt-b'));
  // Excluded tiers never make it into the config.
  assert.ok(!block.includes('ultra'));
  assert.ok(!block.includes('"off"'));
});

test('buildConfigBlock omits efforts lines when unknown', () => {
  const block = buildConfigBlock(
    [{ slug: 'gpt-x', displayName: 'X', description: '', contextWindow: null, defaultEffort: null, efforts: [] }],
    1456,
  );
  const entry = block.slice(block.indexOf('[models.'));
  assert.match(entry, /\[models\."chatgpt\/gpt-x"\]\nprovider = "kimi-gpt-bridge"\nmodel = "gpt-x"\ncapabilities =/);
  assert.ok(!entry.includes('max_context_size'));
  assert.ok(!entry.includes('support_efforts'));
  assert.ok(!entry.includes('default_effort'));
});

test('buildConfigBlock safely escapes dynamic strings and is valid TOML', () => {
  const slug = 'gpt."quoted"\\path\n控制';
  const effort = 'hi"gh\\tier\t';
  const block = buildConfigBlock(
    [
      { slug, contextWindow: 1000, defaultEffort: effort, efforts: [effort] },
      { slug, contextWindow: 2000, defaultEffort: 'duplicate', efforts: [] },
    ],
    '1456"#',
  );
  const parsed = parseToml(block);
  assert.equal(parsed.providers['kimi-gpt-bridge'].base_url, 'http://127.0.0.1:1456"#/v1');
  assert.equal(parsed.models[`chatgpt/${slug}`].model, slug);
  assert.deepEqual(parsed.models[`chatgpt/${slug}`].support_efforts, [effort]);
  assert.equal(parsed.models[`chatgpt/${slug}`].default_effort, effort);
  assert.equal(Object.keys(parsed.models).length, 1);
  assert.throws(
    () => buildConfigBlock([{ slug: 'bad\ud800', efforts: [] }], 1456),
    /lone surrogates/,
  );
});

test('stripBridgeTables removes hoisted unmarked duplicates left by Kimi Code rewrites', () => {
  // Kimi Code re-serializes config.toml on some writes: it hoists our tables
  // into its canonical providers/models sections and drops the marker
  // comments. Sync/teardown must find our entries by identity, not markers.
  const hoisted = [
    '[providers.kimi-gpt-bridge]',
    'type = "openai"',
    'base_url = "http://127.0.0.1:1456/v1"',
    'api_key = "kimi-gpt-bridge"',
    '',
    '[providers.other]',
    'type = "openai"',
    'api_key = "x"',
    '',
    '[models."chatgpt/gpt-9"]',
    'provider = "kimi-gpt-bridge"',
    'model = "gpt-9"',
    '',
    '[models."other/x"]',
    'provider = "other"',
    'model = "x"',
    '',
  ].join('\n');
  const stripped = stripBridgeTables(hoisted);
  assert.ok(!stripped.includes('kimi-gpt-bridge'));
  assert.ok(!stripped.includes('chatgpt/gpt-9'));
  assert.ok(stripped.includes('[providers.other]'));
  assert.ok(stripped.includes('api_key = "x"'));
  assert.ok(stripped.includes('[models."other/x"]'));

  // upsert on a file containing hoisted duplicates must not create a second copy.
  const block = buildConfigBlock(STATIC_FALLBACK_MODELS, 1456);
  const once = upsertConfigBlock(hoisted, block);
  assert.equal(once.match(/\[providers\.kimi-gpt-bridge\]/g).length, 1);
  assert.equal(once.match(/# >>> kimi-gpt-bridge >>>/g).length, 1);
  const parsed = parseToml(once);
  assert.equal(parsed.providers.other.api_key, 'x');
  assert.equal(parsed.providers['kimi-gpt-bridge'].type, 'openai');
});

test('stripBridgeTables parses equivalent TOML header identities and preserves other tables', () => {
  const config = [
    `${MARKER_START} unrelated words`,
    `[ providers . 'kimi-gpt-bridge' ] # trailing comment`,
    'type = "openai"',
    `[ providers . "kimi\\u002Dgpt-bridge" . 'env' ] # child`,
    'secret = "remove"',
    `[ models . 'chatgpt/literal' ] # literal key`,
    'model = "literal"',
    `[ models . "chatgpt\\u002Fbasic" . overrides ] # escaped basic key`,
    'temperature = 1',
    `[ models . 'chatgptish/keep' ] # similar but not owned`,
    'provider = "other"',
    `[ providers . 'kimi-gpt-bridge-other' ]`,
    'type = "keep"',
    `[ models . 'other/keep' ]`,
    'model = "keep"',
    `${MARKER_END} unrelated words`,
    '',
  ].join('\n');
  const stripped = stripBridgeTables(config);
  assert.ok(stripped.includes(`${MARKER_START} unrelated words`));
  assert.ok(stripped.includes(`${MARKER_END} unrelated words`));
  assert.ok(!stripped.includes('secret ='));
  assert.ok(!stripped.includes('model = "literal"'));
  assert.ok(!stripped.includes('temperature ='));
  assert.ok(stripped.includes("[ models . 'chatgptish/keep' ]"));
  assert.ok(stripped.includes("[ providers . 'kimi-gpt-bridge-other' ]"));
  assert.ok(stripped.includes("[ models . 'other/keep' ]"));
  parseToml(stripped);

  const multiline = [
    'note = """',
    `[models.'chatgpt/not-a-header']`,
    `default_model = 'chatgpt/not-an-assignment'`,
    '"""',
    '[other]',
    'keep = true',
    '',
  ].join('\n');
  assert.equal(stripBridgeTables(multiline), multiline);
  assert.deepEqual(findChatgptModelReferences(multiline), []);
});

test('stripBridgeTables removes top-level dotted ownership assignments and their multiline values', () => {
  const config = [
    `providers.kimi-gpt-bridge.type = "openai"`,
    `providers.kimi-gpt-bridge.base_url = """`,
    `http://127.0.0.1:1456/v1`,
    `"""`,
    `models."chatgpt/old".provider = [`,
    `  "kimi-gpt-bridge",`,
    `]`,
    `providers.other.type = "openai"`,
    `models."other/keep".provider = "other"`,
    `providers.kimi-gpt-bridge-other.type = "keep"`,
    `models."chatgptish/keep".provider = "keep"`,
    `[other]`,
    `providers.kimi-gpt-bridge.type = "relative-keep"`,
    `models."chatgpt/relative".provider = '''`,
    `relative-keep`,
    `'''`,
    '',
  ].join('\n');
  const original = parseToml(config);
  assert.equal(original.providers['kimi-gpt-bridge'].type, 'openai');
  assert.deepEqual(original.models['chatgpt/old'].provider, ['kimi-gpt-bridge']);

  const stripped = stripBridgeTables(config);
  const parsed = parseToml(stripped);
  assert.equal(parsed.providers['kimi-gpt-bridge'], undefined);
  assert.equal(parsed.models['chatgpt/old'], undefined);
  assert.equal(parsed.providers.other.type, 'openai');
  assert.equal(parsed.models['other/keep'].provider, 'other');
  assert.equal(parsed.providers['kimi-gpt-bridge-other'].type, 'keep');
  assert.equal(parsed.models['chatgptish/keep'].provider, 'keep');
  assert.equal(parsed.other.providers['kimi-gpt-bridge'].type, 'relative-keep');
  assert.equal(parsed.other.models['chatgpt/relative'].provider, 'relative-keep\n');
});

test('findChatgptModelReferences handles quoted and dotted TOML forms', () => {
  const config = [
    `default_model = 'chatgpt/primary' # trailing`,
    `[ 'secondary_model' ] # table`,
    `default_model = "chatgpt/sec\\u006Fndary"`,
    `[ secondary_model . models ]`,
    `'chatgpt/literal' = 1`,
    `"chatgpt/basic\\u002Dkey" = 2`,
    `'other/keep' = 3`,
    `[other]`,
    `default_model = 'chatgpt/not-top-level'`,
    `secondary_model.models.'chatgpt/dotted' = 4`,
    '',
  ].join('\n');
  assert.deepEqual(findChatgptModelReferences(config), [
    'default_model = "chatgpt/primary"',
    '[secondary_model] default_model = "chatgpt/secondary"',
    '[secondary_model.models] entry "chatgpt/literal"',
    '[secondary_model.models] entry "chatgpt/basic-key"',
  ]);
  assert.deepEqual(
    findChatgptModelReferences(`secondary_model.default_model = 'chatgpt/dotted'\nsecondary_model.models.'chatgpt/map' = 1\n`),
    [
      '[secondary_model] default_model = "chatgpt/dotted"',
      '[secondary_model.models] entry "chatgpt/map"',
    ],
  );
});

test('findChatgptModelReferences decodes multiline basic and literal strings', () => {
  const config = [
    `default_model = """`,
    `chatgpt/multiline-basic"""`,
    `[secondary_model]`,
    `default_model = '''`,
    `chatgpt/multiline-literal'''`,
    `[secondary_model.models]`,
    `"chatgpt/map" = 1`,
    '',
  ].join('\n');
  const parsed = parseToml(config);
  assert.equal(parsed.default_model, 'chatgpt/multiline-basic');
  assert.equal(parsed.secondary_model.default_model, 'chatgpt/multiline-literal');
  assert.deepEqual(findChatgptModelReferences(config), [
    'default_model = "chatgpt/multiline-basic"',
    '[secondary_model] default_model = "chatgpt/multiline-literal"',
    '[secondary_model.models] entry "chatgpt/map"',
  ]);
});

test('findChatgptModelReferences leaves inline-table decoding to tomllib', () => {
  const config = `secondary_model = { default_model = "chatgpt/inline", models = { "chatgpt/map" = 1 } }\n`;
  const parsed = parseToml(config);
  assert.equal(parsed.secondary_model.default_model, 'chatgpt/inline');
  assert.equal(parsed.secondary_model.models['chatgpt/map'], 1);
  assert.deepEqual(findChatgptModelReferences(config), []);
});

test('upsertConfigBlock appends once and replaces in place (idempotent)', () => {
  const blockA = buildConfigBlock([STATIC_FALLBACK_MODELS[0]], 1456);
  const blockB = buildConfigBlock(STATIC_FALLBACK_MODELS, 1456);

  // Empty file → the block alone.
  assert.equal(upsertConfigBlock('', blockA), blockA);
  // Existing content without markers → appended at the end.
  const appended = upsertConfigBlock('theme = "dark"\n', blockA);
  assert.ok(appended.startsWith('theme = "dark"\n\n'));
  assert.ok(appended.endsWith(blockA));
  // Existing markers → replaced, not duplicated.
  const replaced = upsertConfigBlock(appended, blockB);
  assert.equal(replaced, `theme = "dark"\n\n${blockB}`);
  assert.equal(replaced.match(/# >>> kimi-gpt-bridge >>>/g).length, 1);
  // Replacing again with the same block is a no-op.
  assert.equal(upsertConfigBlock(replaced, blockB), replaced);
});

test('fetchModelCatalog GETs the catalog endpoint with auth headers', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    return new Response(JSON.stringify({ models: CATALOG }), { status: 200 });
  };
  process.env.KGB_UPSTREAM_BASE = 'https://example.test/backend-api';
  try {
    const catalog = await fetchModelCatalog({ access: 'tok', accountId: 'acct_1' }, fetchImpl);
    assert.equal(catalog.length, CATALOG.length);
  } finally {
    delete process.env.KGB_UPSTREAM_BASE;
  }
  assert.equal(calls[0].url, 'https://example.test/backend-api/codex/models?client_version=0.146.0');
  assert.equal(calls[0].headers.authorization, 'Bearer tok');
  assert.equal(calls[0].headers['chatgpt-account-id'], 'acct_1');
  assert.equal(calls[0].headers.originator, 'kimi-gpt-bridge');
});

test('fetchModelCatalog throws on non-2xx and bad shapes', async () => {
  await assert.rejects(() => fetchModelCatalog({ access: 't' }, async () => new Response('nope', { status: 500 })));
  await assert.rejects(
    () => fetchModelCatalog({ access: 't' }, async () => new Response('{}', { status: 200 })),
    /models/,
  );
});

// --- /v1/models: dynamic catalog with stubbed fetch, then static fallback ---

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

test('GET /v1/models serves the live catalog and falls back on failure', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-models-test-'));
  process.env.KGB_HOME = tmpDir;
  saveAuth({ access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600_000, accountId: 'acct_1', planType: 'plus' });
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.KGB_HOME;
    clearModelCache();
  });

  // Dynamic: stubbed fetch answers the catalog endpoint.
  clearModelCache();
  const catalogFetch = async (url) => {
    assert.match(url, /\/codex\/models\?client_version=/);
    return new Response(JSON.stringify({ models: CATALOG }), { status: 200 });
  };
  const bridge = createBridgeServer({ sessionId: 'sess-models', fetchImpl: catalogFetch });
  await listen(bridge);
  t.after(() => bridge.close());
  const base = `http://127.0.0.1:${bridge.address().port}`;

  const res = await fetch(`${base}/v1/models`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'list');
  assert.deepEqual(
    body.data.map((m) => m.id),
    ['gpt-a', 'gpt-b'],
  );
  assert.deepEqual(body.data[0], { id: 'gpt-a', object: 'model', created: 1750000000, owned_by: 'openai' });
  // The fetch wrote the file cache.
  assert.deepEqual(JSON.parse(fs.readFileSync(modelsCachePath(), 'utf8')).ids, ['gpt-a', 'gpt-b']);

  // Fallback: fetch fails and no cache is fresh → static list.
  clearModelCache();
  fs.rmSync(modelsCachePath(), { force: true });
  const failing = createBridgeServer({ sessionId: 'sess-models', fetchImpl: async () => new Response('boom', { status: 500 }) });
  await listen(failing);
  t.after(() => failing.close());
  const res2 = await fetch(`http://127.0.0.1:${failing.address().port}/v1/models`);
  const body2 = await res2.json();
  assert.deepEqual(
    body2.data.map((m) => m.id),
    STATIC_FALLBACK_MODELS.map((m) => m.slug),
  );
});

// --- setup replace-vs-append against a temp KIMI_CODE_HOME (offline, logged out) ---

test('setup appends then replaces the marker block idempotently', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-setup-test-'));
  const env = {
    ...process.env,
    KIMI_CODE_HOME: tmpDir,
    KGB_HOME: path.join(tmpDir, 'kgb'),
    KGB_PORT: '1499',
  };
  const run = () => {
    const r = spawnSync(process.execPath, [CLI_PATH, 'setup'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  try {
    const configFile = path.join(tmpDir, 'config.toml');
    const first = run();
    assert.match(first.stdout, /Added the kimi-gpt-bridge provider/);
    assert.match(first.stdout, /Not logged in/); // fallback list, no network
    const content1 = fs.readFileSync(configFile, 'utf8');
    assert.ok(content1.startsWith(MARKER_START));
    assert.ok(content1.includes('chatgpt/gpt-5.6-terra'));

    const second = run();
    assert.match(second.stdout, /Updated the kimi-gpt-bridge provider/);
    const content2 = fs.readFileSync(configFile, 'utf8');
    assert.equal(content2, content1); // replace is idempotent
    assert.equal(content2.match(/# >>> kimi-gpt-bridge >>>/g).length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
