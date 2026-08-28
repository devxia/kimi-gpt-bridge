import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  configPath,
  loadConfig,
  saveConfig,
  resolveProxy,
  describeProxy,
  redactProxyUrl,
  mergeNoProxy,
  shouldReexecWithProxy,
  reexecExitCode,
} from '../src/proxy.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));

let tmpDir;
let savedProxyEnv;
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-proxy-test-'));
  process.env.KGB_HOME = tmpDir;
  // The dev/CI shell may legitimately export proxy env vars; isolate tests.
  savedProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_ENV_KEYS) delete process.env[k];
});
test.afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.KGB_HOME;
  delete process.env.KGB_PROXY;
  for (const k of PROXY_ENV_KEYS) {
    if (savedProxyEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProxyEnv[k];
  }
});

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, KGB_HOME: tmpDir },
    encoding: 'utf8',
  });
}

test('save/load roundtrip and file mode 0600', () => {
  saveConfig({ proxy: 'http://127.0.0.1:PORT' });
  assert.deepEqual(loadConfig(), { proxy: 'http://127.0.0.1:PORT' });
  assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
});

test('loadConfig returns {} when no config exists', () => {
  assert.deepEqual(loadConfig(), {});
});

test('resolveProxy: null when nothing is set', () => {
  assert.equal(resolveProxy(), null);
});

test('resolveProxy: config value used when no env override', () => {
  saveConfig({ proxy: 'http://127.0.0.1:PORT' });
  assert.equal(resolveProxy(), 'http://127.0.0.1:PORT');
});

test('resolveProxy: KGB_PROXY env wins over config', () => {
  saveConfig({ proxy: 'http://127.0.0.1:PORT' });
  process.env.KGB_PROXY = 'http://127.0.0.1:1080';
  assert.equal(resolveProxy(), 'http://127.0.0.1:1080');
});

test('resolveProxy: HTTPS_PROXY env is the fallback when nothing else is set', () => {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
  assert.equal(resolveProxy(), 'http://127.0.0.1:8080');
});

test('resolveProxy: persisted config wins over HTTPS_PROXY env', () => {
  saveConfig({ proxy: 'http://127.0.0.1:PORT' });
  process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
  assert.equal(resolveProxy(), 'http://127.0.0.1:PORT');
});

test('redactProxyUrl hides proxy credentials and describeProxy uses it', () => {
  const proxy = 'http://alice:s3cr3t@proxy.example:8080';
  process.env.KGB_PROXY = proxy;
  const redacted = redactProxyUrl(proxy);
  assert.equal(redacted, 'http://***:***@proxy.example:8080/');
  assert.equal(describeProxy().proxy, redacted);
  assert.doesNotMatch(describeProxy().proxy, /alice|s3cr3t/);
});

test('mergeNoProxy preserves existing entries and ensures local callbacks bypass proxy', () => {
  assert.equal(mergeNoProxy('example.com,10.0.0.0/8'), 'example.com,10.0.0.0/8,localhost,127.0.0.1');
  assert.equal(mergeNoProxy('LOCALHOST,127.0.0.1'), 'LOCALHOST,127.0.0.1');
  assert.equal(mergeNoProxy(), 'localhost,127.0.0.1');
});

test('shouldReexecWithProxy requires the exact bootstrapped proxy environment', () => {
  const proxy = 'http://proxy.example:8080';
  assert.equal(shouldReexecWithProxy(proxy, {}), true);
  assert.equal(shouldReexecWithProxy(proxy, { NODE_USE_ENV_PROXY: 'true', HTTPS_PROXY: proxy, HTTP_PROXY: proxy }), true);
  assert.equal(shouldReexecWithProxy(proxy, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy, HTTP_PROXY: 'http://other' }), true);
  assert.equal(shouldReexecWithProxy(proxy, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy, HTTP_PROXY: proxy }), false);
  assert.equal(shouldReexecWithProxy(proxy, { KGB_REEXEC: '1' }), false);
  assert.equal(shouldReexecWithProxy(null, {}), false);
});

test('reexecExitCode never treats spawn failures or signals as success', () => {
  assert.equal(reexecExitCode({ status: 0 }), 0);
  assert.equal(reexecExitCode({ status: 7 }), 7);
  assert.notEqual(reexecExitCode({ status: 0, signal: 'SIGTERM' }), 0);
  assert.notEqual(reexecExitCode({ status: 0, error: new Error('spawn failed') }), 0);
  assert.notEqual(reexecExitCode({ status: null, signal: 'SIGTERM' }), 0);
  assert.notEqual(reexecExitCode({ status: null, signal: null, error: new Error('spawn failed') }), 0);
});

test('proxy subcommand: bare reports none on a fresh home', () => {
  const r = runCli(['proxy']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No proxy configured/);
});

test('proxy subcommand: set persists to config.json', () => {
  const r = runCli(['proxy', 'http://127.0.0.1:PORT']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Proxy saved to config/);
  const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  assert.equal(stored.proxy, 'http://127.0.0.1:PORT');

  const show = runCli(['proxy']);
  assert.match(show.stdout, /http:\/\/127\.0\.0\.1:PORT/);
  assert.match(show.stdout, /config\.json/);
});

test('proxy subcommand: off removes the stored proxy', () => {
  runCli(['proxy', 'http://127.0.0.1:PORT']);
  const r = runCli(['proxy', 'off']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /removed/i);
  const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  assert.equal(stored.proxy, undefined);

  const show = runCli(['proxy']);
  assert.match(show.stdout, /No proxy configured/);
});
