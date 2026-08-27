---
name: using-kimi-gpt-bridge
description: How the kimi-gpt-bridge plugin works and how to set it up, log in, troubleshoot, and uninstall. Use when the user asks about the ChatGPT bridge, its configuration, login, ports, or removal.
---

# Using KimiGPT Bridge

## What it does

KimiGPT Bridge lets Kimi Code CLI use a **ChatGPT Plus/Pro subscription** instead of a metered API key. It runs a tiny local HTTP server that speaks the OpenAI Chat Completions API and forwards requests to ChatGPT's internal Codex backend, authenticated with OAuth tokens from a browser (or device-code) login.

## Architecture

```
Kimi Code CLI
   │  OpenAI-compatible API (api_key is a placeholder; loopback only)
   ▼
127.0.0.1:1456  ── kimi-gpt-bridge server (this plugin, `src/cli.js serve`)
   │  translates Chat Completions ⇄ Codex Responses, attaches OAuth token
   ▼
https://chatgpt.com/backend-api/codex/responses
```

## Requirements

- Node.js ≥ 18 (no npm dependencies).
- A ChatGPT Plus/Pro subscription.
- Ports: **1455** is the OAuth callback listener (fixed, allow-listed by OpenAI — cannot change) and is only used during login; **1456** is the bridge server (override with `KGB_PORT`).

## Setup flow

1. Log in (opens a browser; `--device` for headless machines):
   `node <pluginRoot>/src/cli.js login`
2. Register the provider in Kimi Code:
   `node <pluginRoot>/src/cli.js setup`
3. In Kimi Code: `/reload`, then `/model` → `chatgpt/<slug>` (e.g. `chatgpt/gpt-5.6-terra`).
4. The plugin's SessionStart hook (`hooks/ensure-running.mjs`) auto-starts the server; or run `node <pluginRoot>/src/cli.js ensure-running` manually.

The model list is synced live from ChatGPT (`GET /backend-api/codex/models`) during `setup` when logged in, filtered to models visible in your plan, with each model's reasoning efforts written as `support_efforts`/`default_effort`. To refresh it later: `node <pluginRoot>/src/cli.js models sync` (or the refresh slash command), then `/reload`. To inspect the catalog without changing config: `node <pluginRoot>/src/cli.js models list`. If the live fetch fails, a built-in fallback list (currently gpt-5.6-terra, gpt-5.5, gpt-5.4-mini) is used. Reasoning effort can also be set via the model name suffix: `gpt-5.6-terra-high`, `gpt-5.6-terra-low`, etc.

## Where files live

- `~/.kimi-gpt-bridge/` (override with `KGB_HOME`): `auth.json` (OAuth tokens, mode 0600), `config.json` (proxy setting), `models-cache.json` (model list cache, 4h TTL), `server.pid`, `server.log`.
- `${KIMI_CODE_HOME:-~/.kimi-code}/config.toml`: the block between `# >>> kimi-gpt-bridge >>>` and `# <<< kimi-gpt-bridge <<<` added by `setup`.

## Troubleshooting

- `status` shows login state and token expiry: `node <pluginRoot>/src/cli.js status`.
- Login fails with `Country, region, or territory not supported` or `fetch failed`: `auth.openai.com` / `chatgpt.com` are not directly reachable. The bridge automatically honors `HTTPS_PROXY`/`HTTP_PROXY` shell env vars; if those are unset (e.g. only a macOS *system* proxy exists), persist one explicitly and retry:
  `node <pluginRoot>/src/cli.js proxy http://127.0.0.1:PORT` (your local HTTP proxy address), then `node <pluginRoot>/src/cli.js login`. Requires Node ≥ 24.5 (`NODE_USE_ENV_PROXY`).
- 401s: the bridge force-refreshes the token once; if refresh itself fails permanently the tokens are dead — run `login` again.
- 429s from ChatGPT include the plan and a "try again in ~N min" hint.
- Login fails with no browser / port 1455 busy: use `login --device` (device-code flow) or the manual-paste fallback.
- Server won't start: check `~/.kimi-gpt-bridge/server.log`; make sure port 1456 is free.

## Uninstall

1. `node <pluginRoot>/src/cli.js teardown [--purge]` — stops the server and removes the config block; `--purge` also deletes `~/.kimi-gpt-bridge` (credentials).
2. In Kimi Code: `/plugins remove kimi-gpt-bridge`, then `/reload`.
