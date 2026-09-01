# KimiGPT Bridge

Use your **ChatGPT Plus/Pro subscription** inside [Kimi Code](https://github.com/MoonshotAI/kimi-code) — no metered OpenAI API key or pay-as-you-go billing. Once you log in with your ChatGPT account, supported GPT models appear in `/model` and conversations consume your subscription quota.

## What you get

- **ChatGPT subscription as the model provider**: OAuth login using the Codex flow; Kimi Code's main agent runs on GPT models through the local bridge
- **Live model list with reasoning levels**: models available to your plan are synced from ChatGPT, including supported `low`/`medium`/`high`/`xhigh`/`max` efforts where advertised
- **Chat Completions and Responses compatibility**: `/v1/chat/completions`, `/v1/responses`, and `/v1/models` are available on loopback
- **Tool-call continuity**: tool constraints are forwarded, and encrypted reasoning is carried into the immediately following tool-result turn
- **Usage visibility**: `status` reports account details, token state, and best-effort subscription usage
- **Safe automatic maintenance**: the server starts with Kimi Code sessions, rotating refresh tokens are coordinated across processes, and configuration changes are validated before atomic replacement
- **Zero npm runtime dependencies**: the application uses Node.js built-ins; config-writing commands invoke the system's Python TOML parser

## How it works

The plugin runs an OpenAI-compatible server on `127.0.0.1:${KGB_PORT:-1456}` and translates requests to ChatGPT's Codex backend:

```
Kimi Code ──▶ local bridge server ──▶ chatgpt.com/backend-api/codex (your subscription)
         ◀── OpenAI-compatible JSON/SSE ◀──
```

Credentials stay on your machine (`~/.kimi-gpt-bridge/auth.json`, mode 0600) and the server listens on loopback only. The generated Kimi Code provider uses `api_key = "kimi-gpt-bridge"`; generation endpoints require the matching `Authorization: Bearer kimi-gpt-bridge` header. This fixed value authenticates local bridge clients—it is not an OpenAI API key.

## Protocol behavior

- For both Chat Completions and Responses, omitted `stream` and `stream: false` return one JSON response; `stream: true` returns SSE, matching the OpenAI default.
- Request bodies are limited to **32 MiB**.
- Chat SSE only emits `[DONE]` after a valid terminal event, and Responses SSE is passed through only while tracking an explicit terminal event. Truncated or failed streams surface an error, and stopping downstream consumption cancels the upstream request/body.
- Requests preserve supported `tool_choice` and parallel-tool constraints. Encrypted reasoning items are returned for portable continuation and retained as a bounded, one-turn fallback for an adjacent tool-output round.
- Upstream requests remain subscription-safe (`store: false`, streaming transport, encrypted reasoning included) even when the local client asks for non-streaming JSON.

## Requirements

- Node.js ≥ 18 (≥ 24.5 when using Node's environment-proxy support)
- Python 3.11+ with `tomllib` for validated `setup`, `models sync`, and `teardown` config writes
- A ChatGPT **Plus / Pro** subscription
- Port **1455** for the fixed OAuth callback (login only) and `${KGB_PORT:-1456}` for the bridge server

Browser OAuth waits up to 10 minutes. Device-code login waits up to 15 minutes.

## Quickstart — 4 steps, all inside Kimi Code

```
1. /plugins install https://github.com/devxia/kimi-gpt-bridge
2. /kimi-gpt-bridge:login      # a browser opens for ChatGPT sign-in
3. /kimi-gpt-bridge:setup      # validates and atomically updates config.toml
4. /reload, then /model → chatgpt/gpt-5.6-terra
```

From then on the bridge server starts automatically with every session.

## Command reference

| Slash command | CLI equivalent | What it does |
|---|---|---|
| `/kimi-gpt-bridge:login` | `login [--device]` | ChatGPT OAuth login; `--device` uses the 15-minute headless flow |
| `/kimi-gpt-bridge:setup` | `setup` | Write/update the provider and model entries after real TOML validation |
| `/kimi-gpt-bridge:refresh` | `models sync` | Refresh models, refusing changes that would invalidate configured default-model references |
| — | `models list` | Show the live model catalog without changing config |
| `/kimi-gpt-bridge:status` | `status` | Login state and best-effort subscription usage |
| `/kimi-gpt-bridge:start` | `ensure-running` | Start the bridge on `KGB_PORT` (default 1456) if its health identity is absent |
| — | `serve [--port N]` | Run the server in the foreground (for debugging) |
| — | `proxy [<url>\|off]` | Show / set / clear the network proxy; displayed credentials are redacted |
| — | `logout` | Delete credentials under the same lock used by refresh |
| `/kimi-gpt-bridge:uninstall` | `teardown [--purge]` | Stop verified bridge processes from all port-scoped PID records and remove config; `--purge` also deletes credentials, unless a bridge is still reachable on the configured port |

CLI commands run as `node ~/.kimi-code/plugins/managed/kimi-gpt-bridge/src/cli.js <command>`.

## Configuration safety

Kimi Code may rewrite `config.toml`, move provider/model tables, and remove marker comments. Setup, refresh, and teardown therefore locate bridge entries by TOML table identity rather than markers alone. Writes are checked with a real TOML parser and replace the file atomically. A model refresh is rejected instead of overwriting config if it would leave `default_model`, `[secondary_model].default_model`, or `[secondary_model.models]` pointing at removed `chatgpt/...` entries.

Server process records are scoped by port. Lifecycle commands verify the `/health` service identity before trusting or stopping a PID, avoiding collisions with unrelated loopback services.

## Troubleshooting

**Login fails with `Country, region, or territory not supported` or `fetch failed`**
Your network cannot reach OpenAI directly. The bridge automatically honors `HTTPS_PROXY` / `HTTP_PROXY`; if your terminal does not expose them (for example, only a macOS system proxy is configured), persist a proxy and retry:

```bash
node ~/.kimi-code/plugins/managed/kimi-gpt-bridge/src/cli.js proxy http://127.0.0.1:PORT
```

Proxy resolution order: `KGB_PROXY` env → persisted `config.json` → `HTTPS_PROXY`/`HTTP_PROXY` env. Proxy usernames and passwords are redacted from CLI output.

**Server will not start**
Check the configured port and health identity, then inspect `~/.kimi-gpt-bridge/server.log`:

```bash
PORT="${KGB_PORT:-1456}"
curl -s "http://127.0.0.1:${PORT}/health"
```

**429 / usage-limit errors**
A subscription window is exhausted. The error includes reset information when the upstream provides it; `status` shows the live usage response when available.

**Changing reasoning effort**
Use Kimi Code's Thinking control or a model suffix such as `gpt-5.6-terra-high` or `gpt-5.6-terra-max`. Only efforts advertised for a model should be selected; `ultra`, `off`, and `none` are not exposed.

## Uninstall

Order matters—clean config while the plugin commands still exist:

1. `/kimi-gpt-bridge:uninstall` — checks all recorded ports, stops only health-verified bridge processes, and removes provider/model entries (you can also delete credentials)
2. `/plugins remove kimi-gpt-bridge`, then `/reload`

The managed plugin copy (`~/.kimi-code/plugins/managed/kimi-gpt-bridge/`) and OpenAI-side OAuth grant are not removed automatically. Revoke the grant from ChatGPT account settings under Connected apps if desired.
