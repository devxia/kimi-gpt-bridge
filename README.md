# KimiGPT Bridge

Use your **ChatGPT Plus/Pro subscription** inside [Kimi Code](https://github.com/MoonshotAI/kimi-code) — no metered OpenAI API key or pay-as-you-go billing. Once you log in with your ChatGPT account, supported GPT models appear in `/model` and conversations consume your subscription quota.

## What you get

- **ChatGPT subscription as the model provider**: OAuth login using the Codex flow; Kimi Code's main agent runs on GPT models through the local bridge
- **Live model list with reasoning levels**: models available to your plan are synced from ChatGPT, including supported `minimal`/`low`/`medium`/`high`/`xhigh`/`max` efforts where advertised
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

## Update models in an existing installation

When ChatGPT releases a new model or retires an old one, run these commands **one at a time in Kimi Code**:

1. `/kimi-gpt-bridge:refresh` — wait for the model refresh to finish.
2. `/reload` — reload the updated configuration.
3. `/model` — choose an available `chatgpt/...` model.

You do not need to uninstall the plugin or repeat setup. If refresh reports that you are not logged in, run `/kimi-gpt-bridge:login`, then retry refresh.

**With plugin version 0.1.5 or later, refreshing preserves your existing custom model settings**, including reasoning effort, context size, custom display names, and extra settings. New models are added and missing settings are filled in. If you use an older plugin version, update the installed plugin through Kimi Code's plugin management before refreshing to get this protection.

If an old model is no longer available:

- Switch to an available model with `/model`.
- If refresh reports that a retired model is still referenced, replace the references it lists in your main/secondary model settings, then run refresh and `/reload` again. A refused refresh leaves your config unchanged.
- Models explicitly retired by the plugin are removed when no longer referenced. A model merely missing from ChatGPT's latest list stays in your config to preserve its settings. If you no longer want that entry, remove its `[models."chatgpt/<old-model>"]` configuration and any references from `config.toml`, then run `/reload`.

If a new model still does not appear, inspect the models currently offered to your account without changing your config:

```bash
node "${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-gpt-bridge/src/cli.js" models list
```

Only models available to your account can be added by a live refresh. To refresh from a terminal instead, run the same command with `models sync` in place of `models list`, then return to Kimi Code and run `/reload` and `/model`.

## Command reference

| Slash command | CLI equivalent | What it does |
|---|---|---|
| `/kimi-gpt-bridge:login` | `login [--device]` | ChatGPT OAuth login; `--device` uses the 15-minute headless flow |
| `/kimi-gpt-bridge:setup` | `setup [--port N]` | Add provider/models and fill missing settings, preserving existing customizations |
| `/kimi-gpt-bridge:refresh` | `models sync [--port N]` | Merge catalog additions and explicit retirements, preserving customizations and validating final model references |
| — | `models list` | Show the live model catalog without changing config |
| `/kimi-gpt-bridge:status` | `status` | Login state and best-effort subscription usage |
| `/kimi-gpt-bridge:start` | `ensure-running` | Start the bridge on `KGB_PORT` (default 1456) if its health identity is absent |
| — | `serve [--port N]` | Run the server in the foreground (for debugging) |
| — | `proxy [<url>\|off]` | Show / set / clear the network proxy; displayed credentials are redacted |
| — | `logout` | Delete credentials under the same lock used by refresh |
| `/kimi-gpt-bridge:uninstall` | `teardown [--purge]` | Stop verified bridge processes from all port-scoped PID records and remove config; `--purge` also deletes credentials, unless a bridge is still reachable on the configured port |

CLI commands run as `node ~/.kimi-code/plugins/managed/kimi-gpt-bridge/src/cli.js <command>`.

## Model policy

The live catalog still follows your account's plan and upstream visibility, rather than a fixed allowlist. The offline fallback includes:

| Model | Default effort | Supported efforts |
|---|---|---|
| GPT-6-Sol / GPT-6-Luna | `medium` | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6-Astra | `medium` (bridge override) | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-5.6-Sol (Older) | `low` | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-5.6-Terra / GPT-5.6-Luna (Older) | `medium` | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-5.5 (Legacy) | `medium` | `low`, `medium`, `high`, `xhigh` |

These fallback models use a **272000-token** context window. New live entries use `context_window`, not `max_context_window`; existing user-configured windows are preserved. GPT-5.5 gets the display name `GPT-5.5 (Legacy)` when its name is missing or still `GPT-5.5`. Custom display names and its `chatgpt/gpt-5.5` alias remain unchanged.

GPT-5.4-Mini is retired: it is excluded from live, fallback, and cached lists. Both generation endpoints return HTTP 400 (`model_retired`) for `gpt-5.4-mini`, including the supported Chat effort suffixes. Other unknown model IDs continue to pass through. A usable cached list is only filtered, never padded with newly added models; if nothing remains, the bridge tries the live catalog and then the offline fallback.

Astra uses `medium` when no effort is supplied on either generation endpoint. Explicit Chat `reasoning_effort` takes precedence over a model suffix; either overrides the default. Responses preserves explicit `reasoning.effort` and other reasoning fields. Config refresh preserves an existing Astra `default_effort`; `medium` is the default for new entries or missing settings, subject to the configured supported efforts.

If Mini is referenced by a main or secondary default/model map, `setup` and `models sync` refuse to write and leave the original file unchanged. Select a replacement yourself before refreshing; unreferenced Mini entries are removed safely. Other existing models, including GPT-5.5, remain configured even if the latest catalog omits them. This preserves their settings and references; it does not guarantee that upstream will still accept requests for them.

Editing this checkout does **not** update the installed managed plugin. Update that copy separately, restart its running bridge, and refresh model config for these changes to take effect in Kimi Code.

## Configuration safety

`setup` and `models sync` merge additions into the existing configuration. They add new models and fill missing fields while preserving existing model/provider values, extra fields, nested settings, and comments. They do not replace the whole bridge block. For example, an existing Astra `default_effort = "high"` stays `high` after refresh. Existing models absent from the latest catalog are retained unless explicitly retired.

The provider's existing URL and custom settings are preserved. An explicit `--port` or nonempty `KGB_PORT` overrides the provider URL; `--port` takes precedence. Missing fields use generated defaults, including `api_key = "kimi-gpt-bridge"` for a new provider.

Kimi Code may rewrite `config.toml`, move provider/model tables, and remove marker comments. Config updates therefore use decoded TOML identities rather than markers alone. The complete merged candidate is checked with a real TOML parser and installed atomically. Main and secondary model references are checked against the final merged configuration, so a retained model absent from the latest catalog remains valid. Missing or retired references cause a refusal to write, leaving the original file unchanged. Teardown still removes bridge entries.

Server process records are scoped by port. Lifecycle commands verify the `/health` service identity before trusting or stopping a PID, avoiding collisions with unrelated loopback services.

## Troubleshooting

**Login fails with `Country, region, or territory not supported` or `fetch failed`**
Your network cannot reach OpenAI directly. The bridge automatically honors `HTTPS_PROXY` / `HTTP_PROXY`; if your terminal does not expose them (for example, only a macOS system proxy is configured), persist a proxy and retry:

```bash
node ~/.kimi-code/plugins/managed/kimi-gpt-bridge/src/cli.js proxy http://127.0.0.1:PORT
```

Proxy resolution order: `KGB_PROXY` env → persisted `config.json` → `HTTPS_PROXY`/`HTTP_PROXY` env. Proxy usernames and passwords are redacted from CLI output.

**A newly released ChatGPT model does not appear**
The Codex backend gates catalog entries on a per-model `minimal_client_version`. The bridge auto-tracks the latest `@openai/codex` release for catalog requests (cached for a day, floored at the pinned version), so `models sync` picks up new models as soon as OpenAI's own CLI does. Set `KGB_CLIENT_VERSION` to pin a version yourself; `status` shows the resolved version and its source.

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
