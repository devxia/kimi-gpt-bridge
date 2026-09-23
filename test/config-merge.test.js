import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mergeConfigModels } from '../src/config-merge.js';
import { STATIC_FALLBACK_MODELS } from '../src/models.js';

function parse(text) {
  const parsed = spawnSync('python3', ['-c', 'import json, sys, tomllib; json.dump(tomllib.loads(sys.stdin.read()), sys.stdout, default=str)'], { input: text, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}
const astra = STATIC_FALLBACK_MODELS.find((m) => m.slug === 'gpt-6-astra');
const legacy = STATIC_FALLBACK_MODELS.find((m) => m.slug === 'gpt-5.5');
function merge(text, models = STATIC_FALLBACK_MODELS, options = {}) {
  const result = mergeConfigModels(text, models, 1456, options);
  assert.equal(mergeConfigModels(result, models, 1456, options), result, 'sync must be byte-idempotent');
  return result;
}

test('incremental merge keeps every existing field, comment, nested table and omitted model', () => {
  const original = `# user preamble
default_model = 'chatgpt/omitted'
secondary_model = { default_model = 'chatgpt/omitted', models = { 'chatgpt/omitted' = 0 } }
[ providers . 'kimi-gpt-bridge' ] # custom provider
type = 'custom'
base_url = 'https://localhost:5999/custom/v2?x=1' # exact URL
api_key = ''
enabled = false
[providers.kimi-gpt-bridge.headers]
X-Test = 'keep'
[ models . "chatgpt\\u002Fgpt-6-astra" ] # custom model
provider = 'other'
model = 'custom-upstream'
max_context_size = 0
capabilities = []
support_efforts = ['high']
default_effort = 'high' # explicit wins
display_name = 'My Astra'
unknown = false
[models.'chatgpt/gpt-6-astra'.extra]
limit = 0
[models.'chatgpt/omitted']
model = 'unlisted-model'
custom = { a = [1, 2], b = false }
[unrelated]
keep = 'verbatim'
`;
  const result = merge(original);
  assert.ok(result.startsWith(original), 'a complete user model/provider must remain verbatim');
  const before = parse(original);
  const after = parse(result);
  assert.deepEqual(after.providers, before.providers);
  for (const alias of Object.keys(before.models)) assert.deepEqual(after.models[alias], before.models[alias]);
  assert.deepEqual(after.secondary_model, before.secondary_model);
  assert.equal(after.default_model, before.default_model);
  assert.deepEqual(after.unrelated, before.unrelated);
  assert.equal(after.models['chatgpt/gpt-6-sol'].max_context_size, 272000);
});

test('Astra fills only missing defaults and respects even empty or false existing values', () => {
  for (const [fields, expected] of [
    ['', 'medium'],
    ['support_efforts = ["high", "max"]\n', 'high'],
    ['support_efforts = []\n', undefined],
    ['support_efforts = false\n', undefined],
    ['default_effort = "high"\n', 'high'],
    ['default_effort = false\n', false],
    ['default_effort = 0\n', 0],
    ['default_effort = ""\n', ''],
  ]) {
    const text = `[models.'chatgpt/gpt-6-astra']\n${fields}`;
    const result = merge(text, [astra]);
    assert.ok(result.includes(fields));
    const model = parse(result).models['chatgpt/gpt-6-astra'];
    assert.equal(model.default_effort, expected);
    assert.equal(model.model, 'gpt-6-astra');
  }
  const inconsistentCatalog = { ...astra, efforts: ['high'] };
  assert.equal(parse(merge('', [inconsistentCatalog])).models['chatgpt/gpt-6-astra'].default_effort, 'high');
});

test('Legacy display name migrates only absent or stock names, even outside the catalog', () => {
  for (const models of [[legacy], [astra]]) {
    for (const [name, expected] of [[null, 'GPT-5.5 (Legacy)'], ['GPT-5.5', 'GPT-5.5 (Legacy)'], ['Custom', 'Custom'], ['', '']]) {
      const original = `[models.'chatgpt/gpt-5.5']\nmodel = 'gpt-5.5'\n${name === null ? '' : `display_name = '${name}' # keep comment\n`}`;
      const result = merge(original, models);
      assert.equal(parse(result).models['chatgpt/gpt-5.5'].display_name, expected);
      assert.ok(result.includes("model = 'gpt-5.5'"));
      if (name !== null) assert.ok(result.includes('# keep comment'));
    }
  }
});

test('provider URL is preserved byte-for-byte unless an explicit override is requested', () => {
  for (const base of ["'https://remote.example:5999/custom/v2?q=1'", '""', 'false', '0']) {
    const text = `[providers.kimi-gpt-bridge]\nbase_url = ${base} # endpoint\napi_key = ''\n`;
    const result = merge(text, [astra]);
    assert.ok(result.includes(`base_url = ${base} # endpoint`));
    assert.equal(parse(result).providers['kimi-gpt-bridge'].api_key, '');
    const override = merge(text, [astra], { overrideBaseUrl: true });
    assert.ok(override.includes('"http://127.0.0.1:1456/v1" # endpoint'));
    assert.equal(parse(override).providers['kimi-gpt-bridge'].base_url, 'http://127.0.0.1:1456/v1');
  }
});

test('common TOML representations support missing fields, inline edits, nested and multiline values', () => {
  const variants = [
    `models."chatgpt/gpt-6-astra".extra.note = '''literal\n[models.fake]\n'''\nmodels.'chatgpt/gpt-6-astra'.support_efforts = [\n 'high', # comment\n 'max',\n]\n`,
    `[models]\n'chatgpt/gpt-6-astra'.support_efforts = ['high']\n'chatgpt/gpt-6-astra'.extra = { x = 0 }\n`,
    `models = { 'chatgpt/gpt-6-astra' = { support_efforts = ['high'], extra = { x = 0 } }, other = { x = false } } # keep\n`,
    `models = { 'chatgpt/gpt-6-astra'.support_efforts = ['high'], 'chatgpt/gpt-6-astra'.extra.x = 0 }\n`,
    `[models.'chatgpt/gpt-6-astra'.extra]\nnote = """\n[providers.fake]\nescaped \\\" quote and ending"""\n[models.'chatgpt/gpt-6-astra']\nsupport_efforts = ['high']\n`,
    `[models.'chatgpt/gpt-6-astra']\nsupport_efforts = ['high']\nnote = """ends with two quotes"""""\nother = ["""array\n[models.fake]\n""", { x = 'y' }]\n`,
    `providers = { 'kimi-gpt-bridge' = { base_url = 'https://example.test/custom', headers = { x = 'y' } } }\nmodels = {}\n`,
    `[providers]\n'kimi-gpt-bridge' = { base_url = 'https://example.test/custom', headers = { x = 'y' } }\n[models]\n'chatgpt/gpt-6-astra' = { support_efforts = ['high'], extra = { x = 0 } }\n`,
  ];
  for (const text of variants) {
    const before = parse(text);
    const result = merge(text, [astra, legacy]);
    const after = parse(result);
    assert.equal(after.models['chatgpt/gpt-6-astra'].default_effort, before.models?.['chatgpt/gpt-6-astra']?.support_efforts ? 'high' : 'medium');
    for (const [key, value] of Object.entries(before.models?.['chatgpt/gpt-6-astra'] ?? {})) {
      assert.deepEqual(after.models['chatgpt/gpt-6-astra'][key], value);
    }
    if (text.includes('# keep')) assert.ok(result.includes('# keep'));
    assert.equal(after.models['chatgpt/gpt-5.5'].display_name, 'GPT-5.5 (Legacy)');
  }
});

test('retirement removes aliases and their nested configuration without dropping neighbors', () => {
  const variants = [
    `[models.'chatgpt/gpt-5.4-mini-max']\nmodel = 'gpt-5.4-mini'\n[models.'chatgpt/gpt-5.4-mini-max'.extra]\na = [1, 2]\n[models.keep]\nmodel = 'gpt-future'\n`,
    `models.'chatgpt/gpt-5.4-mini'.model = 'gpt-5.4-mini'\nmodels.keep.model = 'gpt-future'\n`,
    `models = { 'chatgpt/gpt-5.4-mini' = { model = 'gpt-5.4-mini' }, keep = { model = 'gpt-future' } }\n`,
    `models = { keep = { model = 'gpt-future' }, 'chatgpt/gpt-5.4-mini' = { model = 'gpt-5.4-mini' } }\n`,
    `models = { 'chatgpt/gpt-5.4-mini' = { model = 'gpt-5.4-mini' } }\n`,
    `models = { 'chatgpt/gpt-5.4-mini'.model = 'gpt-5.4-mini', keep.model = 'gpt-future', 'chatgpt/gpt-5.4-mini'.extra.x = 0 }\n`,
    `models = { keep.model = 'gpt-future', 'chatgpt/gpt-5.4-mini'.model = 'gpt-5.4-mini', 'chatgpt/gpt-5.4-mini'.extra.x = 0 }\n`,
    `[models.custom]\nprovider = 'kimi-gpt-bridge'\nmodel = 'gpt-5.4-mini-high'\n[models.keep]\nmodel = 'gpt-future'\n`,
    `[models.'chatgpt/custom']\nmodel = 'gpt-5.4-mini'\n`,
  ];
  for (const text of variants) {
    const result = merge(text, [astra]);
    const actual = parse(result);
    assert.doesNotMatch(result, /gpt-5\.4-mini|models\.custom/);
    if (parse(text).models.keep) assert.deepEqual(actual.models.keep, parse(text).models.keep);
  }
});

test('final references allow omitted configured models and reject genuinely missing or retired aliases', () => {
  for (const reference of [
    (alias) => `default_model = '${alias}'\n`,
    (alias) => `secondary_model = { default_model = '${alias}' }\n`,
    (alias) => `secondary_model.models.'${alias}' = 0\n`,
  ]) {
    const retained = `[models.'chatgpt/omitted']\nmodel = 'omitted'\n`;
    assert.equal(parse(merge(reference('chatgpt/omitted') + retained, [astra])).models['chatgpt/omitted'].model, 'omitted');
    for (const alias of ['chatgpt/missing', 'chatgpt/gpt-5.4-mini', 'my-mini']) {
      const retired = `[models.my-mini]\nprovider = 'kimi-gpt-bridge'\nmodel = 'gpt-5.4-mini'\n`;
      assert.throws(() => merge(reference(alias) + retired, [astra]), /missing or retired.*final merged configuration/s);
    }
  }
});

test('CRLF, no final newline, quoted keys and unrelated array tables survive merge', () => {
  const text = "# keep\r\n[[unrelated.items]]\r\nwhen = 1979-05-27T07:32:00Z\r\nvalue = inf\r\n[ 'models' . 'chatgpt/gpt-6-astra' ]\r\nsupport_efforts = [ 'high' ]";
  const result = merge(text, [astra]);
  assert.ok(result.includes("support_efforts = [ 'high' ]"));
  assert.ok(result.includes('when = 1979-05-27T07:32:00Z\r\nvalue = inf\r\n'));
  // Infinity is valid TOML but cannot pass through this test's JSON helper.
  assert.equal(parse(result.replace('value = inf', 'value = 1')).models['chatgpt/gpt-6-astra'].default_effort, 'high');
});

test('unsafe model/provider array tables and scalar containers refuse instead of overwriting', () => {
  for (const text of [
    `[[models.'chatgpt/gpt-6-astra']]\nmodel = 'gpt-6-astra'\n`,
    `providers = false\n`,
    `models.'chatgpt/gpt-6-astra' = 0\n`,
    `providers.kimi-gpt-bridge = []\n`,
  ]) assert.throws(() => merge(text, [astra]), /Cannot safely merge config.toml/);
});

test('incremental insertion safely escapes catalog aliases and display names', () => {
  const slug = 'gpt."quoted"\\path\n控制';
  const displayName = 'Name "quoted"\\path\n控制\u0001';
  const text = 'theme = "dark" # unchanged\n';
  const result = merge(text, [{ ...astra, slug, displayName }]);
  assert.ok(result.startsWith(text));
  const model = parse(result).models[`chatgpt/${slug}`];
  assert.equal(model.model, slug);
  assert.equal(model.display_name, displayName);
});
