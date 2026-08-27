#!/usr/bin/env node
// kimi-gpt-bridge CLI: login, serve, status, logout, setup, ensure-running, teardown.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  generatePKCE,
  generateState,
  buildAuthorizeUrl,
  parseManualInput,
  extractAccountInfo,
  exchangeCode,
  requestDeviceCode,
  pollDeviceToken,
  REDIRECT_URI,
  DEVICE_REDIRECT_URI,
  DEVICE_PAGE_URL,
  CALLBACK_HOST,
  CALLBACK_PORT,
} from './oauth.js';
import { fileURLToPath } from 'node:url';
import { kgbHome, loadAuth, saveAuth, deleteAuth, getValidToken } from './token-store.js';
import { startServer, getPort } from './server.js';
import { upstreamBase, upstreamHeaders } from './upstream.js';
import { configPath, loadConfig, saveConfig, describeProxy, reexecWithProxyIfNeeded } from './proxy.js';
import {
  MARKER_START,
  STATIC_FALLBACK_MODELS,
  fetchModelCatalog,
  selectModels,
  buildConfigBlock,
  upsertConfigBlock,
  stripBridgeTables,
  saveModelsCache,
} from './models.js';

const CLI_PATH = decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

const USAGE = `kimi-gpt-bridge — use your ChatGPT Plus/Pro subscription in Kimi Code

Usage: kimi-gpt-bridge <command> [options]

Commands:
  login [--device]     Log in with your ChatGPT account (OAuth)
  serve [--port N]     Run the local OpenAI-compatible server (foreground)
  status               Show auth state and token expiry
  logout               Delete stored credentials
  setup                Add/update the bridge provider in Kimi Code's config.toml
                       (syncs the live model list when logged in)
  models sync          Refresh config.toml model entries from ChatGPT
  models list          Show the live ChatGPT model catalog (no config changes)
  ensure-running       Start the server in the background if not running
  proxy [<url>|off]    Show, set, or clear the network proxy (for login/server)
  teardown [--purge]   Stop the server and remove the config block
                       (--purge also deletes ~/.kimi-gpt-bridge)

Environment:
  KGB_HOME             Credential/state dir (default ~/.kimi-gpt-bridge)
  KGB_PORT             Server port (default 1456)
  KGB_UPSTREAM_BASE    Upstream API base (default https://chatgpt.com/backend-api)
  KGB_PROXY            Proxy URL for outbound requests (overrides config.json)
`;

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--device') flags.device = true;
    else if (a === '--purge') flags.purge = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--port') flags.port = Number(args[++i]);
    else if (a.startsWith('--port=')) flags.port = Number(a.slice('--port='.length));
    else throw new Error(`Unknown option: ${a}`);
  }
  return flags;
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: platform === 'win32' });
    child.unref();
  } catch {
    // Browser could not be opened; the URL is printed for manual use.
  }
}

function promptLine(question) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (d) => {
      buf += d;
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        process.stdin.pause();
        process.stdin.off('data', onData);
        resolve(buf.slice(0, idx).trim());
      }
    };
    process.stdin.on('data', onData);
  });
}

const SUCCESS_PAGE = `<!doctype html><html><head><title>kimi-gpt-bridge</title></head>
<body style="font-family:system-ui;text-align:center;padding-top:4em">
<h1>Login successful</h1><p>You can close this window and return to the terminal.</p>
</body></html>`;

const ERROR_PAGE = (msg) => `<!doctype html><html><head><title>kimi-gpt-bridge</title></head>
<body style="font-family:system-ui;text-align:center;padding-top:4em">
<h1>Login failed</h1><p>${msg}</p><p>Go back to the terminal and try again.</p>
</body></html>`;

// Waits for the OAuth redirect on 127.0.0.1:1455 (port is allow-listed upstream).
// Rejects with err.code === 'CALLBACK_BIND_FAILED' if the port cannot be bound.
function waitForCallback(expectedState, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the login callback (10 minutes).'));
    }, timeoutMs);

    const finish = (fn, value) => {
      clearTimeout(timer);
      server.close();
      fn(value);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(ERROR_PAGE('Missing authorization code in the redirect.'));
        finish(reject, new Error('Missing authorization code in the redirect.'));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(ERROR_PAGE('State mismatch.'));
        finish(reject, new Error('State mismatch in the OAuth callback.'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(SUCCESS_PAGE);
      finish(resolve, code);
    });

    server.once('error', (err) => {
      clearTimeout(timer);
      const bindErr = new Error(`Could not bind ${CALLBACK_HOST}:${CALLBACK_PORT}: ${err.message}`);
      bindErr.code = 'CALLBACK_BIND_FAILED';
      reject(bindErr);
    });
    server.listen(CALLBACK_PORT, CALLBACK_HOST);
  });
}

function persistLogin(tokens) {
  const info = extractAccountInfo(tokens.access);
  const auth = {
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    accountId: info.accountId,
  };
  if (info.email) auth.email = info.email;
  if (info.planType) auth.planType = info.planType;
  saveAuth(auth);
  console.log(`\nLogged in as ${info.email ?? 'unknown'} (plan: ${info.planType ?? 'unknown'}).`);
  console.log(`Credentials saved to ${path.join(kgbHome(), 'auth.json')}`);
  // If login only worked because a proxy env var was set, persist it so the
  // bridge server (and future logins) use it automatically via re-exec.
  const usedProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (usedProxy) {
    const config = loadConfig();
    config.proxy = usedProxy;
    saveConfig(config);
    console.log(`Proxy saved to config (${usedProxy}): the bridge server will use it automatically.`);
  }
}

async function cmdLogin(flags) {
  if (flags.device) {
    const dc = await requestDeviceCode();
    console.log('Device login:');
    console.log(`  1. Open ${DEVICE_PAGE_URL}`);
    console.log(`  2. Enter code: ${dc.userCode}\n`);
    console.log('Waiting for authorization...');
    const { authorizationCode, codeVerifier } = await pollDeviceToken(dc);
    const tokens = await exchangeCode(authorizationCode, codeVerifier, DEVICE_REDIRECT_URI);
    persistLogin(tokens);
    return;
  }

  const { verifier, challenge } = generatePKCE();
  const state = generateState();
  const url = buildAuthorizeUrl({ codeChallenge: challenge, state });

  console.log('Open this URL to log in with your ChatGPT account:\n');
  console.log(`  ${url}\n`);

  let code;
  try {
    const callbackPromise = waitForCallback(state);
    openBrowser(url);
    console.log(`Waiting for the browser callback on ${CALLBACK_HOST}:${CALLBACK_PORT} (up to 10 minutes)...`);
    code = await callbackPromise;
  } catch (err) {
    if (err.code !== 'CALLBACK_BIND_FAILED') throw err;
    console.log(`\n${err.message}`);
    console.log('Falling back to manual mode: after logging in, copy the full redirect URL from the browser address bar.');
    const line = await promptLine('Paste the redirect URL or code here: ');
    code = parseManualInput(line, state).code;
  }

  const tokens = await exchangeCode(code, verifier, REDIRECT_URI);
  persistLogin(tokens);
}

async function cmdServe(flags) {
  const port = flags.port ?? getPort();
  const { server } = await startServer({ port });
  const address = server.address();
  console.log(`kimi-gpt-bridge listening on http://127.0.0.1:${address.port}/v1`);
  console.log(`Logs: ${path.join(kgbHome(), 'server.log')}`);
}

async function cmdStatus() {
  const auth = loadAuth();
  if (!auth) {
    console.log('Not logged in. Run `kimi-gpt-bridge login` to connect your ChatGPT account.');
    return;
  }
  console.log(`Account:     ${auth.email ?? 'unknown'}`);
  console.log(`Plan:        ${auth.planType ?? 'unknown'}`);
  console.log(`Account ID:  ${auth.accountId ?? 'unknown'}`);
  const minsLeft = Math.round((auth.expires - Date.now()) / 60_000);
  console.log(
    `Access token: ${minsLeft > 0 ? `valid (expires in ~${minsLeft} min)` : 'expired (will refresh on next use)'}`,
  );
  // Best-effort usage check — failures are tolerated silently.
  try {
    const valid = await getValidToken();
    const res = await fetch(`${upstreamBase()}/wham/usage`, {
      headers: upstreamHeaders(valid, crypto.randomUUID()),
    });
    if (res.ok) console.log(`Usage:       ${await res.text()}`);
  } catch {
    /* best effort */
  }
}

function cmdLogout() {
  deleteAuth();
  console.log('Logged out — stored credentials deleted.');
}

function kimiConfigPath() {
  const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  return path.join(home, 'config.toml');
}

// Best-effort live catalog; falls back to the built-in list on any failure.
async function resolveModels() {
  const auth = loadAuth();
  if (!auth) {
    console.log('Not logged in — writing the built-in fallback model list (run `login`, then `models sync` for the live list).');
    return STATIC_FALLBACK_MODELS;
  }
  try {
    const valid = await getValidToken();
    const models = selectModels(await fetchModelCatalog(valid), valid.planType);
    if (models.length) {
      console.log(`Fetched ${models.length} models from ChatGPT (plan: ${valid.planType ?? 'unknown'}).`);
      return models;
    }
    console.log('The live catalog had no usable models — writing the built-in fallback list.');
  } catch (err) {
    console.log(`Could not fetch the live model catalog (${err.message}) — writing the built-in fallback list.`);
  }
  return STATIC_FALLBACK_MODELS;
}

function writeConfigBlock(models) {
  const port = getPort();
  const configFile = kimiConfigPath();
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const existing = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const replacing = existing.includes(MARKER_START);
  fs.writeFileSync(configFile, upsertConfigBlock(existing, buildConfigBlock(models, port)));
  return { configFile, replacing };
}

async function cmdSetup() {
  const models = await resolveModels();
  const { configFile, replacing } = writeConfigBlock(models);
  console.log(`${replacing ? 'Updated' : 'Added'} the kimi-gpt-bridge provider in ${configFile}`);
  console.log('\nNext steps:');
  console.log('  1. Run `/reload` in Kimi Code.');
  console.log(`  2. Switch model with \`/model\` → chatgpt/${models[0].slug}`);
  console.log('  3. If the server is not running yet: `kimi-gpt-bridge ensure-running` (or restart Kimi Code).');
}

function printModelLine(m) {
  const efforts = m.efforts?.length ? m.efforts.join('/') : 'default';
  console.log(`  ${m.slug}  default: ${m.defaultEffort ?? '?'}  efforts: ${efforts}  ctx: ${m.contextWindow ?? '?'}`);
}

async function cmdModels(args) {
  const sub = args[0];
  if (sub !== 'sync' && sub !== 'list') {
    console.error('Usage: kimi-gpt-bridge models <sync|list>');
    process.exit(2);
  }
  const auth = await getValidToken();
  const models = selectModels(await fetchModelCatalog(auth), auth.planType);
  if (!models.length) throw new Error('The catalog returned no usable models for this account.');

  if (sub === 'list') {
    console.log(`ChatGPT model catalog (plan: ${auth.planType ?? 'unknown'}):`);
    for (const m of models) console.log(`  ${m.slug}  ${m.displayName}  default: ${m.defaultEffort ?? '?'}  efforts: ${m.efforts.join('/') || 'default'}  ctx: ${m.contextWindow ?? '?'}`);
    return;
  }

  const { configFile, replacing } = writeConfigBlock(models);
  saveModelsCache(models.map((m) => m.slug));
  console.log(`${replacing ? 'Updated' : 'Added'} ${models.length} models in ${configFile}:`);
  for (const m of models) printModelLine(m);
  console.log('\nRun `/reload` in Kimi Code, then pick a model with `/model`.');
}

async function healthy(port, timeoutMs = 1000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// Used by the Kimi Code SessionStart hook — must never fail the session.
async function cmdEnsureRunning(flags) {
  try {
    const port = flags.port ?? getPort();
    if (await healthy(port)) {
      console.log(`kimi-gpt-bridge already running on 127.0.0.1:${port}.`);
      return;
    }
    fs.mkdirSync(kgbHome(), { recursive: true, mode: 0o700 });
    const logFd = fs.openSync(path.join(kgbHome(), 'server.log'), 'a');
    const child = spawn(process.execPath, [CLI_PATH, 'serve'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (await healthy(port)) {
        console.log(`kimi-gpt-bridge started on 127.0.0.1:${port}.`);
        return;
      }
    }
    console.log('kimi-gpt-bridge did not become healthy within 5s — check server.log.');
  } catch (err) {
    console.log(`ensure-running: ${err.message}`);
  } finally {
    process.exitCode = 0; // hooks must never block Kimi Code
  }
}

async function cmdTeardown(flags) {
  const pidFile = path.join(kgbHome(), 'server.pid');
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid) {
      try {
        process.kill(pid, 0); // alive?
        process.kill(pid, 'SIGTERM');
        console.log(`Stopped bridge server (pid ${pid}).`);
      } catch {
        console.log(`Server pid ${pid} is not running.`);
      }
    }
    try { fs.rmSync(pidFile); } catch { /* best effort */ }
  } else {
    console.log('No server.pid found — server is probably not running.');
  }

  const configFile = kimiConfigPath();
  if (fs.existsSync(configFile)) {
    const content = fs.readFileSync(configFile, 'utf8');
    const hasBridgeEntries =
      content.includes(MARKER_START) ||
      /^\s*\[providers\.(?:"kimi-gpt-bridge"|kimi-gpt-bridge)/m.test(content) ||
      /^\s*\[models\."chatgpt\//m.test(content);
    if (hasBridgeEntries) {
      const remaining = stripBridgeTables(content);
      fs.writeFileSync(configFile, remaining);
      console.log(`Removed the kimi-gpt-bridge block from ${configFile}`);
      const stale = [];
      const dm = remaining.match(/^default_model\s*=\s*"([^"]+)"/m);
      if (dm && dm[1].startsWith('chatgpt/')) stale.push(`default_model = "${dm[1]}"`);
      const sm = remaining.match(/^\[secondary_model\][\s\S]*?default_model\s*=\s*"([^"]+)"/m);
      if (sm && sm[1].startsWith('chatgpt/')) stale.push(`[secondary_model] default_model = "${sm[1]}"`);
      for (const key of remaining.matchAll(/^\s*"(chatgpt\/[^"]+)"\s*=/gm)) stale.push(`[secondary_model.models] entry "${key[1]}"`);
      if (stale.length) {
        console.log('\n*** WARNING ***');
        console.log('These settings still reference chatgpt/... models that no longer exist:');
        for (const s of stale) console.log(`  - ${s}`);
        console.log('Kimi Code fails startup validation on unresolved model references.');
        console.log('Edit config.toml or use `/model` (and `/secondary-model`) to pick other models.');
      }
    } else {
      console.log('No kimi-gpt-bridge block found in config.toml.');
    }
  }

  if (flags.purge) {
    fs.rmSync(kgbHome(), { recursive: true, force: true });
    console.log(`Deleted ${kgbHome()} (credentials and logs).`);
  }
  console.log('\nTo finish uninstalling, run `/plugins remove kimi-gpt-bridge` in Kimi Code, then `/reload`.');
}

function cmdProxy(args) {
  const arg = args[0];
  const config = loadConfig();
  if (!arg) {
    const { proxy, source } = describeProxy();
    if (proxy) {
      console.log(`Proxy: ${proxy} (from ${source})`);
    } else {
      console.log('No proxy configured. Set one with `kimi-gpt-bridge proxy <url>`, or the KGB_PROXY / HTTPS_PROXY env vars.');
    }
    return;
  }
  if (arg === 'off') {
    if (!config.proxy) {
      console.log('No proxy configured — nothing to do.');
      return;
    }
    delete config.proxy;
    saveConfig(config);
    console.log('Proxy removed from config.');
    return;
  }
  config.proxy = arg;
  saveConfig(config);
  console.log(`Proxy saved to config (${arg}): the bridge server will use it automatically.`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd) {
    console.log(USAGE);
    process.exit(1);
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    return;
  }
  // Local-only subcommand; its argument is positional, so it bypasses parseFlags.
  if (cmd === 'proxy') {
    cmdProxy(args.slice(1));
    return;
  }
  // Network-touching subcommands re-exec with the configured proxy first —
  // undici only honors proxy env vars set before process startup.
  if (['login', 'serve', 'status', 'ensure-running', 'setup', 'models'].includes(cmd)) {
    reexecWithProxyIfNeeded(fileURLToPath(import.meta.url));
  }
  // `models <sync|list>` takes a positional subcommand, so it bypasses parseFlags.
  if (cmd === 'models') {
    await cmdModels(args.slice(1));
    return;
  }
  let flags;
  try {
    flags = parseFlags(args.slice(1));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (flags.help) {
    console.log(USAGE);
    return;
  }

  switch (cmd) {
    case 'login':
      await cmdLogin(flags);
      break;
    case 'serve':
      await cmdServe(flags);
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'logout':
      cmdLogout();
      break;
    case 'setup':
      await cmdSetup();
      break;
    case 'ensure-running':
      await cmdEnsureRunning(flags);
      break;
    case 'teardown':
      await cmdTeardown(flags);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(USAGE);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
