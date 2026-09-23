import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { healthy, openBrowser, persistLogin, promptLine, waitForCallback } from '../src/cli.js';
import { getValidToken, loadAuth, saveAuth } from '../src/token-store.js';
import { VERSION } from '../src/upstream.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const PROXY_ENV_KEYS = ['KGB_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

function isolatedEnv(tmpDir, extra = {}) {
  const env = { ...process.env, KGB_HOME: path.join(tmpDir, 'kgb'), KIMI_CODE_HOME: path.join(tmpDir, 'kimi'), KGB_REEXEC: '1', ...extra };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  return env;
}

function runCli(tmpDir, args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: isolatedEnv(tmpDir, extraEnv),
    encoding: 'utf8',
  });
}

function runCliAsync(tmpDir, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: isolatedEnv(tmpDir, extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processIsAlive(pid);
}

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('openBrowser absorbs asynchronous spawn errors', async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  assert.doesNotThrow(() => openBrowser('https://example.test', () => child));
  child.emit('error', new Error('launcher missing'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('healthy validates service, port and pid while accepting an older bridge version', async () => {
  let body = { ok: true };
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  try {
    await listen(server);
    const port = server.address().port;
    assert.equal(await healthy(port), null);
    body = { service: 'kimi-gpt-bridge', version: '0.1.0', pid: 123, port };
    assert.deepEqual(await healthy(port, 1000, { pid: 123 }), body);
    assert.equal(await healthy(port, 1000, { pid: 456 }), null);
    body.pid = 0;
    assert.equal(await healthy(port), null);
    body.pid = 123;
    body.port = port + 1;
    assert.equal(await healthy(port), null);
  } finally {
    await closeServer(server);
  }
});

test('persistLogin redacts an environment proxy while storing its original value', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-login-redact-'));
  const originalHome = process.env.KGB_HOME;
  const originalProxy = process.env.HTTPS_PROXY;
  const proxy = 'http://alice:s3cr3t@proxy.example:8080';
  const writes = [];
  const originalWrite = process.stdout.write;
  try {
    process.env.KGB_HOME = tmpDir;
    process.env.HTTPS_PROXY = proxy;
    process.stdout.write = function write(chunk, ...args) {
      writes.push(String(chunk));
      return originalWrite.call(this, '', ...args);
    };
    persistLogin({
      access: jwt({
        email: 'user@example.test',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct', chatgpt_plan_type: 'plus' },
      }),
      refresh: 'refresh',
      expires: Date.now() + 3600_000,
    });
    assert.doesNotMatch(writes.join(''), /alice|s3cr3t/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8')).proxy, proxy);
  } finally {
    process.stdout.write = originalWrite;
    if (originalHome === undefined) delete process.env.KGB_HOME;
    else process.env.KGB_HOME = originalHome;
    if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalProxy;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// The re-exec sets HTTPS_PROXY to resolveProxy(), so persistLogin cannot tell
// a shell proxy from an injected one by value alone. A deliberate one-shot
// KGB_PROXY override, and an existing config entry, must both survive login.
test('persistLogin does not turn a one-shot KGB_PROXY into stored config', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-login-oneshot-'));
  const saved = { KGB_HOME: process.env.KGB_HOME, KGB_PROXY: process.env.KGB_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY };
  const originalWrite = process.stdout.write;
  try {
    process.env.KGB_HOME = tmpDir;
    process.env.KGB_PROXY = 'http://one-shot:9999';
    process.env.HTTPS_PROXY = 'http://one-shot:9999'; // what the re-exec injects
    process.stdout.write = function write(_chunk, ...args) { return originalWrite.call(this, '', ...args); };
    persistLogin({
      access: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } }),
      refresh: 'refresh',
      expires: Date.now() + 3600_000,
    });
    assert.equal(fs.existsSync(path.join(tmpDir, 'config.json')), false, 'a one-shot KGB_PROXY was persisted');
  } finally {
    process.stdout.write = originalWrite;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('persistLogin never overwrites a proxy already stored in config', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-login-keep-'));
  const saved = { KGB_HOME: process.env.KGB_HOME, HTTPS_PROXY: process.env.HTTPS_PROXY };
  const originalWrite = process.stdout.write;
  try {
    process.env.KGB_HOME = tmpDir;
    process.env.HTTPS_PROXY = 'http://from-env:1';
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ proxy: 'http://from-config:2' }), { mode: 0o600 });
    process.stdout.write = function write(_chunk, ...args) { return originalWrite.call(this, '', ...args); };
    persistLogin({
      access: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } }),
      refresh: 'refresh',
      expires: Date.now() + 3600_000,
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8')).proxy, 'http://from-config:2');
  } finally {
    process.stdout.write = originalWrite;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('proxy --help prints help without writing config', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-proxy-help-'));
  try {
    const result = runCli(tmpDir, ['proxy', '--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: kimi-gpt-bridge/);
    assert.equal(fs.existsSync(path.join(tmpDir, 'kgb', 'config.json')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('proxy set output redacts credentials while persisting the original URL', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-proxy-redact-'));
  const proxy = 'http://alice:s3cr3t@proxy.example:8080';
  try {
    const result = runCli(tmpDir, ['proxy', proxy]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /alice|s3cr3t/);
    assert.match(result.stdout, /\*\*\*/);
    const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, 'kgb', 'config.json'), 'utf8'));
    assert.equal(stored.proxy, proxy);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('setup refuses stale chatgpt references and preserves config.toml byte-for-byte', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-stale-'));
  const kimiHome = path.join(tmpDir, 'kimi');
  const configFile = path.join(kimiHome, 'config.toml');
  const original = "default_model = 'chatgpt/retired-model'\n\n[other]\nkeep = true\n";
  try {
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.writeFileSync(configFile, original);
    const result = runCli(tmpDir, ['setup']);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /retired-model/);
    assert.match(`${result.stdout}\n${result.stderr}`, /unchanged|original/i);
    assert.equal(fs.readFileSync(configFile, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(kimiHome), ['config.toml']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('setup and live sync retire mini safely while retaining Legacy references', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-retire-mini-'));
  const kimiHome = path.join(tmpDir, 'kimi');
  const configFile = path.join(kimiHome, 'config.toml');
  const oldTables = '\n[models."chatgpt/gpt-5.4-mini"]\nprovider = "kimi-gpt-bridge"\nmodel = "gpt-5.4-mini"\n';
  const catalog = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: ['gpt-5.4-mini', 'gpt-5.5', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra'].map((slug) => ({
      slug, visibility: 'list', default_reasoning_level: 'low',
    })) }));
  });
  try {
    await listen(catalog);
    fs.mkdirSync(kimiHome, { recursive: true });
    for (const command of [['setup'], ['models', 'sync']]) {
      if (command[0] === 'models') {
        fs.mkdirSync(path.join(tmpDir, 'kgb'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'kgb', 'auth.json'), JSON.stringify({
          access: 'offline-access', refresh: 'offline-refresh', expires: Date.now() + 3_600_000,
        }));
      }
      const env = { KGB_UPSTREAM_BASE: `http://127.0.0.1:${catalog.address().port}`, KGB_CLIENT_VERSION: '0.156.0' };
      for (const reference of [
        'default_model = "chatgpt/gpt-5.4-mini"\n',
        '[secondary_model]\ndefault_model = "chatgpt/gpt-5.4-mini"\n',
        '[secondary_model.models]\n"chatgpt/gpt-5.4-mini" = 1\n',
      ]) {
        const original = reference + oldTables;
        fs.writeFileSync(configFile, original);
        const result = await runCliAsync(tmpDir, command, env);
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, /gpt-5\.4-mini/);
        assert.equal(fs.readFileSync(configFile, 'utf8'), original);
      }
      for (const reference of ['', 'default_model = "chatgpt/gpt-5.5"\n[secondary_model]\ndefault_model = "chatgpt/gpt-5.5"\n[secondary_model.models]\n"chatgpt/gpt-5.5" = 1\n']) {
        fs.writeFileSync(configFile, reference + oldTables + (reference ? '\n[models."chatgpt/gpt-5.5"]\nmodel = "gpt-5.5"\n' : ''));
        const result = await runCliAsync(tmpDir, command, env);
        assert.equal(result.status, 0, result.stderr);
        const text = fs.readFileSync(configFile, 'utf8');
        assert.doesNotMatch(text, /gpt-5\.4-mini/);
        const parsed = spawnSync('python3', ['-c', 'import json, sys, tomllib; json.dump(tomllib.loads(sys.stdin.read()), sys.stdout)'], { input: text, encoding: 'utf8' });
        assert.equal(parsed.status, 0, parsed.stderr);
        const config = JSON.parse(parsed.stdout);
        const legacyAlias = reference ? 'chatgpt/gpt-5.5' : 'kimi-gpt-bridge/gpt-5.5';
        assert.equal(config.models[legacyAlias].model, 'gpt-5.5');
        assert.equal(config.models[legacyAlias].display_name, 'GPT-5.5 (Legacy)');
        assert.equal(config.models[reference ? 'kimi-gpt-bridge/gpt-5.5' : 'chatgpt/gpt-5.5'], undefined);
        assert.equal(config.models['kimi-gpt-bridge/gpt-6-astra'].default_effort, 'medium');
        assert.ok(config.models['kimi-gpt-bridge/gpt-6-sol']);
        assert.ok(config.models['kimi-gpt-bridge/gpt-6-luna']);
        if (reference) {
          assert.equal(config.default_model, 'chatgpt/gpt-5.5');
          assert.equal(config.secondary_model.default_model, 'chatgpt/gpt-5.5');
          assert.equal(config.secondary_model.models['chatgpt/gpt-5.5'], 1);
        }
      }
    }
  } finally {
    await closeServer(catalog);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('setup uses tomllib references for inline tables and multiline strings without modifying config', () => {
  const fixtures = [
    'secondary_model = { default_model = "chatgpt/inline-retired", models = { "chatgpt/inline-map" = 1 } }\n',
    [
      'default_model = """',
      'chatgpt/multiline-retired"""',
      '[secondary_model.models]',
      '"chatgpt/multiline-map" = 1',
      '',
    ].join('\n'),
  ];

  for (const original of fixtures) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-tomllib-refs-'));
    const kimiHome = path.join(tmpDir, 'kimi');
    const configFile = path.join(kimiHome, 'config.toml');
    try {
      fs.mkdirSync(kimiHome, { recursive: true });
      fs.writeFileSync(configFile, original);
      const result = runCli(tmpDir, ['setup']);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /chatgpt\/(?:inline|multiline)/);
      assert.match(`${result.stdout}\n${result.stderr}`, /unchanged|original/i);
      assert.equal(fs.readFileSync(configFile, 'utf8'), original);
      assert.deepEqual(fs.readdirSync(kimiHome), ['config.toml']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test('setup validates the full TOML candidate and cleans its same-directory temp file on failure', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-invalid-toml-'));
  const kimiHome = path.join(tmpDir, 'kimi');
  const configFile = path.join(kimiHome, 'config.toml');
  const original = 'broken = [\n';
  try {
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.writeFileSync(configFile, original);
    const result = runCli(tmpDir, ['setup']);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /invalid config\.toml|TOML/i);
    assert.equal(fs.readFileSync(configFile, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(kimiHome), ['config.toml']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('manual ensure-running reports startup failures with a non-zero exit', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-ensure-fail-'));
  const invalidHome = path.join(tmpDir, 'not-a-directory');
  try {
    fs.writeFileSync(invalidHome, 'file');
    const result = runCli(tmpDir, ['ensure-running', '--port', '1'], { KGB_HOME: invalidHome });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /ensure-running|EEXIST|directory/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('status surfaces a permanent usage authentication failure and exits non-zero', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-status-auth-'));
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/wham/usage');
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'session invalid' } }));
  });
  try {
    await listen(server);
    const kgbHome = path.join(tmpDir, 'kgb');
    fs.mkdirSync(kgbHome, { recursive: true });
    fs.writeFileSync(path.join(kgbHome, 'auth.json'), JSON.stringify({
      access: 'offline-token',
      refresh: 'offline-refresh',
      expires: Date.now() + 3_600_000,
      accountId: 'acct-test',
    }));
    const result = await runCliAsync(tmpDir, ['status'], {
      KGB_UPSTREAM_BASE: `http://127.0.0.1:${server.address().port}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /authentication|session|log in/i);
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('logout waits for an in-flight refresh before reporting credentials deleted', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-logout-lock-'));
  const originalHome = process.env.KGB_HOME;
  try {
    process.env.KGB_HOME = path.join(tmpDir, 'kgb');
    saveAuth({ access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acct' });
    let releaseRefresh;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const refresh = getValidToken(async () => {
      markStarted();
      await new Promise((resolve) => { releaseRefresh = resolve; });
      return {
        ok: true,
        text: async () => JSON.stringify({
          access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } }),
          refresh_token: 'r2',
          expires_in: 3600,
        }),
      };
    });
    await started;
    const logout = runCliAsync(tmpDir, ['logout']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    let settled = false;
    logout.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    releaseRefresh();
    await refresh;
    const result = await logout;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Logged out/);
    assert.equal(loadAuth(), null);
  } finally {
    if (originalHome === undefined) delete process.env.KGB_HOME;
    else process.env.KGB_HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('teardown never kills a legacy pid unless health identifies the same bridge process', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-teardown-pid-'));
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const impostor = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'not-kimi-gpt-bridge', version: '0.1.0', pid: sleeper.pid }));
  });
  try {
    await new Promise((resolve, reject) => {
      sleeper.once('spawn', resolve);
      sleeper.once('error', reject);
    });
    await listen(impostor);
    const kgbHome = path.join(tmpDir, 'kgb');
    fs.mkdirSync(kgbHome, { recursive: true });
    fs.writeFileSync(path.join(kgbHome, 'server.pid'), String(sleeper.pid));
    const legacyFile = path.join(kgbHome, 'server.pid');
    const result = await runCliAsync(tmpDir, ['teardown'], { KGB_PORT: String(impostor.address().port) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(processIsAlive(sleeper.pid), true, 'teardown killed an unrelated process from a legacy pid file');
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), String(sleeper.pid));
    assert.match(result.stdout, /not stop|mismatch|identity|cannot safely|left in place/i);
  } finally {
    if (processIsAlive(sleeper.pid)) sleeper.kill('SIGTERM');
    await closeServer(impostor);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('teardown preserves a port-scoped PID record when health identity does not match a live pid', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-teardown-mismatch-'));
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const impostor = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'kimi-gpt-bridge', version: '0.0.9', pid: sleeper.pid + 1, port: impostor.address().port }));
  });
  try {
    await new Promise((resolve, reject) => {
      sleeper.once('spawn', resolve);
      sleeper.once('error', reject);
    });
    await listen(impostor);
    const kgbHome = path.join(tmpDir, 'kgb');
    const pidFile = path.join(kgbHome, `server-${impostor.address().port}.pid`);
    fs.mkdirSync(kgbHome, { recursive: true });
    const record = {
      service: 'kimi-gpt-bridge',
      version: '0.0.9',
      pid: sleeper.pid,
      port: impostor.address().port,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(pidFile, JSON.stringify(record));

    const result = await runCliAsync(tmpDir, ['teardown']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(processIsAlive(sleeper.pid), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(pidFile, 'utf8')), record);
    assert.match(result.stdout, /not stop|mismatch|identity|left in place/i);
  } finally {
    if (processIsAlive(sleeper.pid)) sleeper.kill('SIGTERM');
    await closeServer(impostor);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('server shutdown preserves a replacement PID record', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-pid-owner-'));
  const blocker = http.createServer();
  let pid;
  try {
    await listen(blocker);
    const port = blocker.address().port;
    await closeServer(blocker);
    const started = await runCliAsync(tmpDir, ['ensure-running', '--port', String(port)]);
    assert.equal(started.status, 0, started.stderr);
    const pidFile = path.join(tmpDir, 'kgb', `server-${port}.pid`);
    const original = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    pid = original.pid;
    const replacement = { ...original, pid: original.pid + 100_000, startedAt: 'replacement' };
    fs.writeFileSync(pidFile, JSON.stringify(replacement));

    process.kill(pid, 'SIGTERM');
    assert.equal(await waitForProcessExit(pid), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(pidFile, 'utf8')), replacement);
  } finally {
    if (pid && processIsAlive(pid)) process.kill(pid, 'SIGTERM');
    if (blocker.listening) await closeServer(blocker);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// An unvalidated --port became NaN and surfaced as "did not become healthy"
// five seconds later, pointing at the server instead of the typo.
test('a malformed --port fails immediately and names the real cause', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-bad-port-'));
  try {
    for (const args of [['serve', '--port', 'abc'], ['serve', '--port=abc'], ['ensure-running', '--port', '70000'], ['serve', '--port', '-1'], ['serve', '--port', '1.5'], ['serve', '--port'], ['serve', '--port', '0']]) {
      const result = runCli(tmpDir, args);
      assert.notEqual(result.status, 0, `${args.join(' ')} was accepted`);
      assert.match(result.stderr, /Invalid --port value/);
      assert.doesNotMatch(result.stderr + result.stdout, /did not become healthy/);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a malformed KGB_PORT is rejected instead of becoming NaN', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-bad-env-port-'));
  try {
    const result = runCli(tmpDir, ['ensure-running'], { KGB_PORT: 'abc' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid KGB_PORT value/);
    assert.doesNotMatch(result.stderr + result.stdout, /did not become healthy/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// PID records can go missing (hand-deleted, or written by an older version).
// Purge must not read that as "nothing is running" and delete credentials from
// under a live server.
test('teardown --purge keeps credentials when a live bridge has no PID record', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-purge-orphan-'));
  const blocker = http.createServer();
  let pid;
  try {
    await listen(blocker);
    const port = blocker.address().port;
    await closeServer(blocker);
    const started = await runCliAsync(tmpDir, ['ensure-running', '--port', String(port)]);
    assert.equal(started.status, 0, started.stderr);

    const pidFile = path.join(tmpDir, 'kgb', `server-${port}.pid`);
    pid = JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid;
    fs.rmSync(pidFile);
    const authFile = path.join(tmpDir, 'kgb', 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify({ access: 'a', refresh: 'r', expires: Date.now() + 60_000 }), { mode: 0o600 });

    const result = await runCliAsync(tmpDir, ['teardown', '--purge'], { KGB_PORT: String(port) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /still running on 127\.0\.0\.1:/);
    assert.match(result.stdout, new RegExp(`pid ${pid}`));
    assert.equal(fs.existsSync(authFile), true, 'purge deleted credentials while the bridge was live');
    assert.equal(processIsAlive(pid), true);
  } finally {
    if (pid && processIsAlive(pid)) process.kill(pid, 'SIGTERM');
    if (pid) await waitForProcessExit(pid);
    if (blocker.listening) await closeServer(blocker);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('teardown --purge still deletes the home when nothing is listening', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-purge-clean-'));
  const blocker = http.createServer();
  try {
    await listen(blocker);
    const port = blocker.address().port;
    await closeServer(blocker);
    const kgbDir = path.join(tmpDir, 'kgb');
    fs.mkdirSync(kgbDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(kgbDir, 'auth.json'), JSON.stringify({ access: 'a' }), { mode: 0o600 });

    const result = await runCliAsync(tmpDir, ['teardown', '--purge'], { KGB_PORT: String(port) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Deleted /);
    assert.equal(fs.existsSync(kgbDir), false);
  } finally {
    if (blocker.listening) await closeServer(blocker);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensure-running passes --port and teardown stops every port-scoped server', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-multi-port-'));
  const blockerA = http.createServer();
  const blockerB = http.createServer();
  const ports = [];
  const pids = new Map();
  try {
    await listen(blockerA);
    ports.push(blockerA.address().port);
    await listen(blockerB);
    ports.push(blockerB.address().port);
    await closeServer(blockerA);
    await closeServer(blockerB);

    for (const port of ports) {
      const result = await runCliAsync(tmpDir, ['ensure-running', '--port', String(port)]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`started on 127\\.0\\.0\\.1:${port}`));
      const record = JSON.parse(fs.readFileSync(path.join(tmpDir, 'kgb', `server-${port}.pid`), 'utf8'));
      assert.equal(record.service, 'kimi-gpt-bridge');
      assert.equal(record.version, VERSION);
      assert.equal(record.port, port);
      assert.equal(processIsAlive(record.pid), true);
      assert.equal(fs.statSync(path.join(tmpDir, 'kgb', `server-${port}.pid`)).mode & 0o777, 0o600);
      pids.set(port, record.pid);
    }
    assert.equal(fs.existsSync(path.join(tmpDir, 'kgb', 'server.pid')), false);

    const teardown = await runCliAsync(tmpDir, ['teardown']);
    assert.equal(teardown.status, 0, teardown.stderr);
    for (const port of ports) {
      assert.match(teardown.stdout, new RegExp(`port ${port}`));
      assert.equal(fs.existsSync(path.join(tmpDir, 'kgb', `server-${port}.pid`)), false);
      assert.equal(await waitForProcessExit(pids.get(port)), true, `server pid ${pids.get(port)} remained alive`);
    }
  } finally {
    for (const port of ports) {
      const file = path.join(tmpDir, 'kgb', `server-${port}.pid`);
      try {
        const { pid } = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (processIsAlive(pid)) process.kill(pid, 'SIGTERM');
      } catch {
        /* already stopped */
      }
    }
    if (blockerA.listening) await closeServer(blockerA);
    if (blockerB.listening) await closeServer(blockerB);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SessionStart hook always exits zero and passes its current port to serve', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-hook-port-'));
  const fakePlugin = path.join(tmpDir, 'plugin root');
  const fakeCli = path.join(fakePlugin, 'src', 'cli.js');
  const argsFile = path.join(tmpDir, 'args.json');
  try {
    fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
    fs.writeFileSync(fakeCli, `require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)))`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../hooks/ensure-running.mjs', import.meta.url))], {
      env: isolatedEnv(tmpDir, { KIMI_PLUGIN_ROOT: fakePlugin, KGB_PORT: '65534' }),
      encoding: 'utf8',
      timeout: 8_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), ['serve', '--port', '65534']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SessionStart hook recognizes a healthy bridge and does not respawn it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-hook-healthy-'));
  const fakePlugin = path.join(tmpDir, 'plugin root');
  const argsFile = path.join(tmpDir, 'args.json');
  const bridge = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'kimi-gpt-bridge', version: VERSION, pid: process.pid, port: bridge.address().port }));
  });
  try {
    fs.mkdirSync(fakePlugin, { recursive: true });
    await listen(bridge);
    // The bridge runs in this process, so the hook must be spawned
    // asynchronously — spawnSync would block the event loop and the health
    // check could never be answered.
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../hooks/ensure-running.mjs', import.meta.url))], {
        env: isolatedEnv(tmpDir, { KIMI_PLUGIN_ROOT: fakePlugin, KGB_PORT: String(bridge.address().port) }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stderr }));
      setTimeout(() => child.kill('SIGKILL'), 8_000).unref();
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(argsFile), false, 'hook spawned serve despite a healthy bridge');
    assert.equal(fs.existsSync(path.join(tmpDir, 'kgb')), false, 'hook created state for a healthy bridge');
  } finally {
    await closeServer(bridge);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SessionStart hook rejects a malformed KGB_PORT without spawning serve', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-hook-badport-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../hooks/ensure-running.mjs', import.meta.url))], {
      env: isolatedEnv(tmpDir, { KIMI_PLUGIN_ROOT: tmpDir, KGB_PORT: 'abc' }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, 'hook must never block session startup');
    assert.match(result.stderr, /invalid KGB_PORT/);
    assert.equal(fs.existsSync(path.join(tmpDir, 'kgb')), false, 'hook spawned state despite the invalid port');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('teardown warnings reuse TOML parsing for indentation and single quotes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-teardown-refs-'));
  const kimiHome = path.join(tmpDir, 'kimi');
  const configFile = path.join(kimiHome, 'config.toml');
  const config = [
    "   default_model = 'chatgpt/retired-model'",
    "secondary_model = { default_model = 'kimi-gpt-bridge/retired-model', models = { 'kimi-gpt-bridge/retired-model' = 0 } }",
    '',
    "[ providers . 'kimi-gpt-bridge' ]",
    'type = "openai"',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.writeFileSync(configFile, config);
    const result = runCli(tmpDir, ['teardown']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /WARNING/);
    assert.match(result.stdout, /default_model = "chatgpt\/retired-model"/);
    assert.match(result.stdout, /default_model = "kimi-gpt-bridge\/retired-model"/);
    assert.match(result.stdout, /\[secondary_model.models\] entry "kimi-gpt-bridge\/retired-model"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('promptLine rejects on stdin EOF instead of hanging', async () => {
  const stdin = new EventEmitter();
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.setEncoding = () => {};
  const pending = promptLine('Paste the redirect URL or code here: ', stdin);
  stdin.emit('end');
  await assert.rejects(pending, /stdin closed before input was received/);
});

test('promptLine resolves the first line and stops listening', async () => {
  const stdin = new EventEmitter();
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.setEncoding = () => {};
  const pending = promptLine('Paste the redirect URL or code here: ', stdin);
  stdin.emit('data', 'abc123\nignored');
  assert.equal(await pending, 'abc123');
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.listenerCount('end'), 0);
});

test('waitForCallback force-closes keep-alive connections on timeout', async () => {
  // A preconnected browser socket must not keep the process alive after the wait fails.
  const waiting = waitForCallback('state-timeout-test', 500);
  const socket = await new Promise((resolve, reject) => {
    const sock = net.createConnection(1455, '127.0.0.1', () => resolve(sock));
    sock.once('error', reject);
  });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  await assert.rejects(waiting, /Timed out waiting for the login callback/);
  await closed;
  assert.equal(socket.destroyed, true);
});

test('setup honors --port in the generated provider config', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-setup-port-'));
  try {
    const result = runCli(tmpDir, ['setup', '--port', '5999']);
    assert.equal(result.status, 0, result.stderr);
    const config = fs.readFileSync(path.join(tmpDir, 'kimi', 'config.toml'), 'utf8');
    assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:5999\/v1"/);
    assert.match(result.stdout, /\/model.*kimi-gpt-bridge\/gpt-6-sol/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('setup prints a preserved legacy alias when it is the only alias for the first model', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-legacy-prompt-'));
  try {
    const file = path.join(tmpDir, 'kimi', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `[models.'chatgpt/gpt-6-sol']\nmodel = 'gpt-6-sol'\n`);
    const result = runCli(tmpDir, ['setup']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\/model.*chatgpt\/gpt-6-sol/);
    assert.equal(parseConfig(fs.readFileSync(file, 'utf8')).models['kimi-gpt-bridge/gpt-6-sol'], undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('KGB_PORT=0 is rejected like any other invalid port', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-zero-port-'));
  try {
    const result = runCli(tmpDir, ['ensure-running'], { KGB_PORT: '0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid KGB_PORT value/);
    assert.doesNotMatch(result.stderr + result.stdout, /did not become healthy/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SIGHUP shuts the server down and removes its PID record', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-sighup-'));
  const blocker = http.createServer();
  let pid;
  try {
    await listen(blocker);
    const port = blocker.address().port;
    await closeServer(blocker);
    const started = await runCliAsync(tmpDir, ['ensure-running', '--port', String(port)]);
    assert.equal(started.status, 0, started.stderr);
    const pidFile = path.join(tmpDir, 'kgb', `server-${port}.pid`);
    const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    pid = record.pid;
    process.kill(pid, 'SIGHUP');
    assert.equal(await waitForProcessExit(pid), true, 'server did not exit on SIGHUP');
    assert.equal(fs.existsSync(pidFile), false, 'PID record was not removed');
  } finally {
    if (pid && processIsAlive(pid)) process.kill(pid, 'SIGTERM');
    if (blocker.listening) await closeServer(blocker);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('an unwritable server.log does not crash the server', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-badlog-'));
  const blocker = http.createServer();
  let stderr = '';
  let exited = false;
  try {
    await listen(blocker);
    const port = blocker.address().port;
    await closeServer(blocker);
    // A directory at the log path makes createWriteStream fail asynchronously.
    fs.mkdirSync(path.join(tmpDir, 'kgb', 'server.log'), { recursive: true });
    const child = spawn(process.execPath, [CLI_PATH, 'serve', '--port', String(port)], {
      env: isolatedEnv(tmpDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', () => { exited = true; });
    try {
      let up = false;
      const deadline = Date.now() + 8000;
      while (!up && Date.now() < deadline && !exited) {
        up = Boolean(await healthy(port));
        if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(up, true, `server never became healthy; stderr: ${stderr}`);
      assert.equal(exited, false, 'server exited after the log stream failed');
      assert.match(stderr, /log write failed|EISDIR/);
    } finally {
      if (!exited) child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  } finally {
    if (blocker.listening) await closeServer(blocker);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a hung python3 makes setup fail with a named timeout instead of blocking', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-pyhang-'));
  const binDir = path.join(tmpDir, 'bin');
  try {
    fs.mkdirSync(binDir, { recursive: true });
    // Merge parsing contains "json.dump"; hang only atomic-write validation.
    const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    assert.equal(python.status, 0, python.stderr);
    fs.writeFileSync(path.join(binDir, 'python3'), [
      '#!/bin/sh',
      'case "$2" in',
      `  *json.dump*) exec "${python.stdout.trim()}" "$@" ;;`,
      '  *) exec sleep 60 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    const result = runCli(tmpDir, ['setup'], { PATH: `${binDir}:/usr/bin:/bin` });
    assert.notEqual(result.status, 0, 'setup succeeded despite a hung validator');
    assert.match(result.stderr + result.stdout, /killed by signal|Could not validate config\.toml/);
    assert.equal(fs.existsSync(path.join(tmpDir, 'kimi', 'config.toml')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// With a request still in flight, server.close() never finishes; the 2s
// fallback must close the log stream and exit anyway.
test('SIGTERM forced-exit fallback fires while a request hangs upstream', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-forced-exit-'));
  const blackhole = http.createServer(() => {});
  let child;
  let client;
  try {
    await listen(blackhole);
    fs.mkdirSync(path.join(tmpDir, 'kgb'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'kgb', 'auth.json'), JSON.stringify({
      access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3_600_000, accountId: 'acct',
    }));
    const blocker = http.createServer();
    await listen(blocker);
    const port = blocker.address().port;
    await closeServer(blocker);
    child = spawn(process.execPath, [CLI_PATH, 'serve', '--port', String(port)], {
      env: isolatedEnv(tmpDir, { KGB_UPSTREAM_BASE: `http://127.0.0.1:${blackhole.address().port}` }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pidFile = path.join(tmpDir, 'kgb', `server-${port}.pid`);
    const startDeadline = Date.now() + 8000;
    while (!fs.existsSync(pidFile) && Date.now() < startDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(fs.existsSync(pidFile), 'server did not write its PID record');

    const body = JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }], stream: true });
    client = net.createConnection(port, '127.0.0.1', () => {
      client.write(
        `POST /v1/chat/completions HTTP/1.1\r\n` +
        `host: 127.0.0.1:${port}\r\n` +
        `authorization: Bearer kimi-gpt-bridge\r\n` +
        `content-type: application/json\r\n` +
        `content-length: ${Buffer.byteLength(body)}\r\n\r\n` +
        body,
      );
    });
    // Let the request reach the hung upstream before signalling.
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill('SIGTERM');
    const code = await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000)),
    ]);
    assert.equal(code, 0, 'serve did not exit 0 via the forced-shutdown fallback');
  } finally {
    client?.destroy();
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await closeServer(blackhole);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('models sync preserves the configured port; --port rewrites it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-sync-port-'));
  const catalog = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      models: [{ slug: 'gpt-sync-port', visibility: 'list', supported_in_api: true, priority: 1 }],
    }));
  });
  try {
    const setup = runCli(tmpDir, ['setup', '--port', '5999'], { KGB_PORT: '' });
    assert.equal(setup.status, 0, setup.stderr);
    const configFile = path.join(tmpDir, 'kimi', 'config.toml');
    assert.match(fs.readFileSync(configFile, 'utf8'), /127\.0\.0\.1:5999/);

    // Credentials plus a local catalog endpoint keep the sync fully offline;
    // KGB_CLIENT_VERSION pins the catalog version so no registry is contacted.
    await listen(catalog);
    fs.mkdirSync(path.join(tmpDir, 'kgb'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'kgb', 'auth.json'), JSON.stringify({
      access: 'offline-access', refresh: 'offline-refresh',
      expires: Date.now() + 3_600_000, accountId: 'acct',
    }));
    const env = {
      KGB_UPSTREAM_BASE: `http://127.0.0.1:${catalog.address().port}`,
      KGB_CLIENT_VERSION: '0.153.0',
      KGB_PORT: '',
    };
    const sync = await runCliAsync(tmpDir, ['models', 'sync'], env);
    assert.equal(sync.status, 0, sync.stderr);
    let config = fs.readFileSync(configFile, 'utf8');
    assert.match(config, /127\.0\.0\.1:5999/, 'sync rewrote the custom port back to the default');
    assert.match(config, /gpt-sync-port/);

    const rewritten = await runCliAsync(tmpDir, ['models', 'sync', '--port', '7000'], env);
    assert.equal(rewritten.status, 0, rewritten.stderr);
    config = fs.readFileSync(configFile, 'utf8');
    assert.match(config, /127\.0\.0\.1:7000/);
    assert.doesNotMatch(config, /127\.0\.0\.1:5999/);
  } finally {
    await closeServer(catalog);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('an explicitly set KGB_PORT wins over the port already in config.toml', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-env-port-'));
  const configFile = path.join(tmpDir, 'kimi', 'config.toml');
  try {
    const first = runCli(tmpDir, ['setup'], { KGB_PORT: '5999' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(fs.readFileSync(configFile, 'utf8'), /127\.0\.0\.1:5999/);

    const second = runCli(tmpDir, ['setup'], { KGB_PORT: '7000' });
    assert.equal(second.status, 0, second.stderr);
    let config = fs.readFileSync(configFile, 'utf8');
    assert.match(config, /127\.0\.0\.1:7000/);
    assert.doesNotMatch(config, /127\.0\.0\.1:5999/);

    // Without KGB_PORT the existing configured port is kept, not reset.
    const third = runCli(tmpDir, ['setup'], { KGB_PORT: '' });
    assert.equal(third.status, 0, third.stderr);
    config = fs.readFileSync(configFile, 'utf8');
    assert.match(config, /127\.0\.0\.1:7000/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function parseConfig(text) {
  const parsed = spawnSync('python3', ['-c', 'import json, sys, tomllib; json.dump(tomllib.loads(sys.stdin.read()), sys.stdout)'], { input: text, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}

test('offline setup and live sync incrementally migrate user configuration and retain missing catalog models', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-merge-'));
  const configFile = path.join(tmpDir, 'kimi', 'config.toml');
  let slugs = ['gpt-6-astra', 'gpt-5.5', 'gpt-live-new', 'gpt-5.4-mini'];
  const catalog = http.createServer((req, res) => {
    assert.match(req.url, /^\/codex\/models\?client_version=/);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: slugs.map((slug) => ({
      slug, visibility: 'list', context_window: 272000, default_reasoning_level: 'low',
      supported_reasoning_levels: ['low', 'medium', 'high'].map((effort) => ({ effort })),
    })) }));
  });
  const original = `# user preamble
default_model = 'chatgpt/omitted'
secondary_model = { default_model = 'chatgpt/omitted', models = { 'chatgpt/omitted' = 0 } }
[ providers . 'kimi-gpt-bridge' ] # provider note
base_url = 'https://remote.example:5999/a/custom/v2?q=1' # exact endpoint
api_key = ''
type = 'custom'
custom_flag = false
[providers.kimi-gpt-bridge.headers]
X-Header = 'kept'
[models.'chatgpt/gpt-6-astra'] # Astra note
default_effort = 'high'
support_efforts = ['high']
capabilities = []
max_context_size = 0
extra.flag = false
[models.'chatgpt/gpt-5.5']
display_name = 'GPT-5.5' # Legacy note
[models.'chatgpt/omitted']
provider = 'kimi-gpt-bridge'
model = 'omitted'
note = '''keep this
[models.fake]
'''
[models.'chatgpt/omitted'.extra]
value = 0
[models.'chatgpt/gpt-5.4-mini']
model = 'gpt-5.4-mini'
[models.mini-alias]
provider = 'kimi-gpt-bridge'
model = 'gpt-5.4-mini-max'
[unrelated]
keep = true
`;
  try {
    await listen(catalog);
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const env = { KGB_UPSTREAM_BASE: `http://127.0.0.1:${catalog.address().port}`, KGB_CLIENT_VERSION: '0.156.0', KGB_PORT: '' };
    for (const command of [['setup'], ['models', 'sync']]) {
      if (command[0] === 'models') {
        fs.mkdirSync(path.join(tmpDir, 'kgb'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'kgb', 'auth.json'), JSON.stringify({ access: 'offline', refresh: 'offline', expires: Date.now() + 3_600_000 }));
      }
      fs.writeFileSync(configFile, original);
      const run = await runCliAsync(tmpDir, command, env);
      assert.equal(run.status, 0, run.stderr);
      if (command[0] === 'setup') assert.match(run.stdout, /Not logged in/);
      const text = fs.readFileSync(configFile, 'utf8');
      const before = parseConfig(original);
      const after = parseConfig(text);
      assert.deepEqual(after.providers, before.providers);
      assert.equal(after.default_model, before.default_model);
      assert.deepEqual(after.secondary_model, before.secondary_model);
      assert.deepEqual(after.models['chatgpt/omitted'], before.models['chatgpt/omitted']);
      for (const [key, value] of Object.entries(before.models['chatgpt/gpt-6-astra'])) assert.deepEqual(after.models['chatgpt/gpt-6-astra'][key], value);
      assert.equal(after.models['chatgpt/gpt-6-astra'].model, 'gpt-6-astra');
      assert.equal(after.models['chatgpt/gpt-5.5'].display_name, 'GPT-5.5 (Legacy)');
      assert.equal(after.models['chatgpt/gpt-5.4-mini'], undefined);
      assert.equal(after.models['mini-alias'], undefined);
      assert.ok(text.includes("base_url = 'https://remote.example:5999/a/custom/v2?q=1' # exact endpoint"));
      for (const comment of ['# user preamble', '# provider note', '# Astra note', '# Legacy note']) assert.ok(text.includes(comment));
      assert.ok(text.includes("note = '''keep this\n[models.fake]\n'''"));
      if (command[0] === 'models') {
        assert.equal(after.models['kimi-gpt-bridge/gpt-6-sol'], undefined, 'live sync must not pad with fallback models');
        assert.equal(after.models['kimi-gpt-bridge/gpt-live-new'].max_context_size, 272000);
      }
      const repeat = await runCliAsync(tmpDir, command, env);
      assert.equal(repeat.status, 0, repeat.stderr);
      assert.equal(fs.readFileSync(configFile, 'utf8'), text);
    }
    // A disappearing catalog entry remains configured and usable as default.
    slugs = ['gpt-live-new'];
    let run = await runCliAsync(tmpDir, ['models', 'sync'], env);
    assert.equal(run.status, 0, run.stderr);
    let text = fs.readFileSync(configFile, 'utf8');
    assert.equal(parseConfig(text).models['chatgpt/gpt-6-astra'].default_effort, 'high');
    // Both explicit mechanisms update the URL, with --port taking precedence.
    run = await runCliAsync(tmpDir, ['models', 'sync'], { ...env, KGB_PORT: '7001' });
    assert.equal(run.status, 0, run.stderr);
    text = fs.readFileSync(configFile, 'utf8');
    assert.equal(parseConfig(text).providers['kimi-gpt-bridge'].base_url, 'http://127.0.0.1:7001/v1');
    run = await runCliAsync(tmpDir, ['models', 'sync', '--port', '7002'], { ...env, KGB_PORT: 'invalid-but-overridden' });
    assert.equal(run.status, 0, run.stderr);
    text = fs.readFileSync(configFile, 'utf8');
    assert.equal(parseConfig(text).providers['kimi-gpt-bridge'].base_url, 'http://127.0.0.1:7002/v1');
    assert.ok(text.includes('# exact endpoint'));
    assert.deepEqual(parseConfig(text).providers['kimi-gpt-bridge'].headers, { 'X-Header': 'kept' });
  } finally {
    await closeServer(catalog);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('setup refuses unsafe TOML shapes and retired custom main/secondary aliases byte-for-byte', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-merge-refusal-'));
  const configFile = path.join(tmpDir, 'kimi', 'config.toml');
  const miniAlias = "\n[models.custom-mini]\nprovider = 'kimi-gpt-bridge'\nmodel = 'gpt-5.4-mini-high'\n";
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    for (const original of [
      `default_model = 'custom-mini'\n${miniAlias}`,
      `secondary_model = { default_model = 'custom-mini' }\n${miniAlias}`,
      `secondary_model.models.custom-mini = 1\n${miniAlias}`,
      `[[models.'chatgpt/gpt-6-astra']]\nmodel = 'gpt-6-astra'\n`,
      `providers = false\n`,
    ]) {
      parseConfig(original);
      fs.writeFileSync(configFile, original);
      const result = runCli(tmpDir, ['setup'], { KGB_PORT: '' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /original config.toml is unchanged/);
      assert.equal(fs.readFileSync(configFile, 'utf8'), original);
      assert.deepEqual(fs.readdirSync(path.dirname(configFile)), ['config.toml']);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('setup handles inline and dotted models, custom Legacy names and consistent missing Astra defaults', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-merge-inline-'));
  const configFile = path.join(tmpDir, 'kimi', 'config.toml');
  const original = `# inline config\nproviders = { 'kimi-gpt-bridge' = { api_key = '', base_url = 'https://example.test/path' } }\nmodels = { 'chatgpt/gpt-6-astra'.support_efforts = ['high'], 'chatgpt/gpt-5.5' = { display_name = 'Personal name', extra = { enabled = false } } }\n`;
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, original);
    let run = runCli(tmpDir, ['setup'], { KGB_PORT: '' });
    assert.equal(run.status, 0, run.stderr);
    const text = fs.readFileSync(configFile, 'utf8');
    const config = parseConfig(text);
    assert.equal(config.models['chatgpt/gpt-6-astra'].default_effort, 'high');
    assert.equal(config.models['chatgpt/gpt-5.5'].display_name, 'Personal name');
    assert.deepEqual(config.models['chatgpt/gpt-5.5'].extra, { enabled: false });
    assert.ok(text.startsWith('# inline config\n'));
    assert.equal(config.providers['kimi-gpt-bridge'].base_url, 'https://example.test/path');
    run = runCli(tmpDir, ['setup'], { KGB_PORT: ' ' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.readFileSync(configFile, 'utf8'), text);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
