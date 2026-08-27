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
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
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

// Effective proxy plus where it came from, for the `proxy` subcommand display.
export function describeProxy() {
  if (process.env.KGB_PROXY) return { proxy: process.env.KGB_PROXY, source: 'KGB_PROXY env var (overrides config)' };
  const configured = loadConfig().proxy;
  if (configured) return { proxy: configured, source: configPath() };
  const env = proxyEnvFallback();
  if (env) return { proxy: env, source: 'HTTPS_PROXY/HTTP_PROXY env var' };
  return { proxy: null, source: null };
}

// Called at the top of CLI dispatch for network-touching subcommands. Setting
// NODE_USE_ENV_PROXY/HTTPS_PROXY inside a running process is too late (undici
// reads them at bootstrap), so we re-exec the same CLI with the env prepared.
// KGB_REEXEC guards against infinite recursion.
export function reexecWithProxyIfNeeded(scriptPath) {
  const proxy = resolveProxy();
  if (!proxy || process.env.NODE_USE_ENV_PROXY || process.env.KGB_REEXEC) return;
  const child = spawnSync(process.execPath, [scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      NO_PROXY: 'localhost,127.0.0.1',
      KGB_REEXEC: '1',
    },
  });
  process.exit(child.status ?? 0);
}
