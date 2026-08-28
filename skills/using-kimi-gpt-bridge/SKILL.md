---
name: using-kimi-gpt-bridge
description: How the kimi-gpt-bridge plugin works and how to set it up, log in, troubleshoot, and uninstall. Use when the user asks about the ChatGPT bridge, its configuration, login, ports, or removal.
---

# Using KimiGPT Bridge

## What it does

KimiGPT Bridge lets Kimi Code use a **ChatGPT Plus/Pro subscription** instead of a metered API key. Its loopback server supports OpenAI-style Chat Completions and Responses requests and forwards them to ChatGPT's Codex backend using browser or device-code OAuth. It has no npm runtime dependencies.

## Architecture

```
Kimi Code CLI
   │  OpenAI-compatible API
   │  Authorization: Bearer kimi-gpt-bridge
   ▼
127.0.0.1:${KGB_PORT:-1456} ── local bridge (`src/cli.js serve`)
   │  attaches OAuth credentials and translates when needed
   ▼
https://chatgpt.com/backend-api/codex/responses
```

`setup` writes `api_key = "kimi-gpt-bridge"`, causing Kimi Code to send the required bearer header. This fixed local credential is not an OpenAI API key.

## Requirements and timeouts

- Node.js ≥ 18; Node ≥ 24.5 is needed for environment-proxy support.
- Python 3.11+ with `tomllib` is required by config-writing commands for independent TOML validation.
- A ChatGPT Plus/Pro subscription.
- **1455** is the fixed, allow-listed OAuth callback port used only during browser login.
- The bridge defaults to **1456** and follows `KGB_PORT`.
- Browser callback login waits 10 minutes; device-code polling waits 15 minutes. Agent-run login Bash calls need a timeout of at least 930 seconds.

## Setup flow

1. Log in: `node <pluginRoot>/src/cli.js login`; use `login --device` for headless systems.
2. Register the provider: `node <pluginRoot>/src/cli.js setup`.
3. Run `/reload`, then choose `chatgpt/<slug>` with `/model`.
4. The SessionStart hook auto-starts the bridge; `ensure-running` starts it manually.

When logged in, `setup` syncs models visible to the account plan and records their context windows and reasoning efforts. `models sync` refreshes config; `models list` only inspects the live catalog. Setup can use the built-in fallback list when logged out or the catalog is unavailable. `max` effort is supported when a model advertises it; `ultra`, `off`, and `none` remain hidden.

Config updates identify bridge tables even after Kimi Code moves them or removes marker comments. The complete candidate is validated by a real TOML parser and installed atomically. A refresh refuses to overwrite config if removing models would invalidate `default_model`, `[secondary_model].default_model`, or `[secondary_model.models]` references.

## API behavior

- Generation routes require exactly `Authorization: Bearer kimi-gpt-bridge`.
- Chat Completions and Responses return JSON when `stream` is omitted or false, and SSE only when it is true.
- Request bodies are limited to 32 MiB.
- Chat SSE requires an explicit terminal event before `[DONE]`; streamed Responses is also checked for an explicit terminal event. Truncation becomes an error, and early downstream termination cancels the upstream request/body.
- Supported tool-selection and parallel-call constraints are preserved.
- Encrypted reasoning is exposed for portable continuation and can be reused only for the immediately adjacent tool-output continuation; fallback cache entries are bounded and one-shot.

## State and lifecycle

- `~/.kimi-gpt-bridge/` (override with `KGB_HOME`) holds `auth.json` (0600), `config.json`, `models-cache.json`, port-scoped process state, and `server.log`.
- `${KIMI_CODE_HOME:-~/.kimi-code}/config.toml` holds the provider and `chatgpt/<slug>` model tables. Markers are informational, not the source of truth.
- Refresh-token rotation is serialized across processes. Logout uses the same credential mutation lock and cannot race an in-flight refresh.
- PID tracking is scoped by server port, and lifecycle commands verify the `/health` service identity before trusting the process.
- Proxy output redacts embedded usernames and passwords. Proxy order is `KGB_PROXY` → persisted config → `HTTPS_PROXY`/`HTTP_PROXY`.

## Troubleshooting

- `status`: `node <pluginRoot>/src/cli.js status`.
- For `Country, region, or territory not supported` or `fetch failed`, configure `node <pluginRoot>/src/cli.js proxy http://127.0.0.1:PORT`, then retry login. A macOS system proxy alone is not visible to Node.
- A 401 triggers one forced refresh and one retry. If refresh is permanently invalid, log in again.
- 429 errors include reset information when supplied upstream.
- If browser login cannot bind 1455, use manual paste or `login --device`.
- If startup fails, inspect `~/.kimi-gpt-bridge/server.log` and check the configured port:
  `PORT="${KGB_PORT:-1456}"; curl -s "http://127.0.0.1:${PORT}/health"`.

## Uninstall

1. `node <pluginRoot>/src/cli.js teardown [--purge]` checks all port-scoped PID records, stops only bridge processes whose health identity and PID match, and removes provider/model tables; `--purge` also deletes local bridge state.
2. Run `/plugins remove kimi-gpt-bridge`, then `/reload`. The managed plugin copy and OpenAI-side OAuth grant remain until removed separately.
