// Proxy config in <KGB_HOME>/config.json plus the re-exec needed for undici
// to pick up proxy env vars (they are read once at process bootstrap).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { kgbHome } from './token-store.js';

export function configPath() {
  return path.join(kgbHome(), 'config.json');
}

export function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

// Atomic write (tmp file + rename) with 0o600 permissions, same as token-store.
export function saveConfig(config) {
  const dir = kgbHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const file = configPath();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  } catch (err) {
    try { fs.rmSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

// Conventional shell proxy env vars, honored so users with a proxied shell
// need zero setup. Note: macOS "system proxy" is NOT visible here — that case
// still needs `kimi-gpt-bridge proxy <url>`.
export function proxyEnvFallback() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null
  );
}

// Resolution order: KGB_PROXY env → persisted config.json → shell proxy env.
// null means "no proxy".
export function resolveProxy() {
  return process.env.KGB_PROXY || loadConfig().proxy || proxyEnvFallback();
}

// Safe for status output: preserve the destination while hiding userinfo.
export function redactProxyUrl(proxy) {
  if (!proxy) return proxy;
  try {
    const url = new URL(proxy);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return String(proxy).replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]*@/i, '$1***:***@');
  }
}

export function mergeNoProxy(noProxy = '') {
  const entries = String(noProxy).split(',').map((entry) => entry.trim()).filter(Boolean);
  const existing = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const local of ['localhost', '127.0.0.1']) {
    if (!existing.has(local)) entries.push(local);
  }
  return entries.join(',');
}

// Pure predicate exported so callers can inspect re-exec behavior without
// spawning a child process or exiting the current one.
// Lowercase proxy vars must be absent: undici prefers them over the uppercase
// spelling, so leaving one in place would silently override the resolved proxy
// even when every uppercase var already matches.
export function shouldReexecWithProxy(proxy, env = process.env) {
  if (!proxy || env.KGB_REEXEC === '1') return false;
  return !(
    env.NODE_USE_ENV_PROXY === '1' &&
    env.HTTPS_PROXY === proxy &&
    env.HTTP_PROXY === proxy &&
    !env.https_proxy &&
    !env.http_proxy &&
    !env.no_proxy
  );
}

// Effective proxy plus where it came from, for the `proxy` subcommand display.
export function describeProxy() {
  if (process.env.KGB_PROXY) return { proxy: redactProxyUrl(process.env.KGB_PROXY), source: 'KGB_PROXY env var (overrides config)' };
  const configured = loadConfig().proxy;
  if (configured) return { proxy: redactProxyUrl(configured), source: configPath() };
  const env = proxyEnvFallback();
  if (env) return { proxy: redactProxyUrl(env), source: 'HTTPS_PROXY/HTTP_PROXY env var' };
  return { proxy: null, source: null };
}

export function reexecExitCode(child) {
  if (child.error || child.signal || !Number.isInteger(child.status)) return 1;
  return child.status;
}

// Called at the top of CLI dispatch for network-touching subcommands. Setting
// NODE_USE_ENV_PROXY/HTTPS_PROXY inside a running process is too late (undici
// reads them at bootstrap), so we re-exec the same CLI with the env prepared.
// KGB_REEXEC only guards the child from a second re-exec.
// undici prefers lowercase proxy vars over their uppercase spelling, so an
// inherited lowercase var would win over the values set here. Drop them and
// keep uppercase as the single source of truth.
export function proxyChildEnv(proxy, env = process.env) {
  const childEnv = {
    ...env,
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    NO_PROXY: mergeNoProxy(env.NO_PROXY ?? env.no_proxy),
    KGB_REEXEC: '1',
  };
  delete childEnv.https_proxy;
  delete childEnv.http_proxy;
  delete childEnv.no_proxy;
  return childEnv;
}

export function reexecWithProxyIfNeeded(scriptPath) {
  const proxy = resolveProxy();
  if (!shouldReexecWithProxy(proxy)) return;
  const child = spawnSync(process.execPath, [scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: proxyChildEnv(proxy),
  });
  process.exit(reexecExitCode(child));
}
