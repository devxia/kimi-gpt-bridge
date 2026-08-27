#!/usr/bin/env node
// Self-contained SessionStart hook: make sure the bridge server is running.
// Runs with cwd = plugin root and KIMI_PLUGIN_ROOT set. Must always exit 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.KGB_PORT || 1456);

function selfDir() {
  return path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
}

const pluginRoot = process.env.KIMI_PLUGIN_ROOT || path.dirname(selfDir());
const kgbHome = process.env.KGB_HOME || path.join(os.homedir(), '.kimi-gpt-bridge');

async function healthy() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

try {
  if (!(await healthy())) {
    fs.mkdirSync(kgbHome, { recursive: true, mode: 0o700 });
    const logFd = fs.openSync(path.join(kgbHome, 'server.log'), 'a');
    const child = spawn(process.execPath, [path.join(pluginRoot, 'src', 'cli.js'), 'serve'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (await healthy()) break;
    }
  }
} catch {
  // Never block Kimi Code session startup.
}
process.exit(0);
