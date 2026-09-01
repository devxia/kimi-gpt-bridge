import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { healthy, openBrowser, persistLogin } from '../src/cli.js';
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
    for (const args of [['serve', '--port', 'abc'], ['serve', '--port=abc'], ['ensure-running', '--port', '70000'], ['serve', '--port', '-1'], ['serve', '--port', '1.5'], ['serve', '--port']]) {
      const result = runCli(tmpDir, args);
      assert.notEqual(result.status, 0, `${args.join(' ')} was accepted`);
      assert.match(result.stderr, /Invalid --port value/);
      assert.doesNotMatch(result.stderr + result.stdout, /did not become healthy/);
    }
    const ok = runCli(tmpDir, ['serve', '--port', '0', '--help']);
    assert.equal(ok.status, 0, ok.stderr);
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

test('teardown warnings reuse TOML parsing for indentation and single quotes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-cli-teardown-refs-'));
  const kimiHome = path.join(tmpDir, 'kimi');
  const configFile = path.join(kimiHome, 'config.toml');
  const config = [
    "   default_model = 'chatgpt/retired-model'",
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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
