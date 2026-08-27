# KimiGPT Bridge

Use your **ChatGPT Plus/Pro subscription** inside [Kimi Code](https://github.com/MoonshotAI/kimi-code) — no API key, no pay-as-you-go billing. Once you log in with your ChatGPT account, GPT-5.6-class models appear in `/model` and every conversation consumes your subscription quota.

## What you get

- **ChatGPT subscription as the model provider**: OAuth login (the same flow as OpenAI's Codex CLI); Kimi Code's main agent runs directly on GPT models
- **Full model list with reasoning levels**: available models (gpt-5.6-sol / terra / luna, gpt-5.5, gpt-5.4, …) are synced from ChatGPT's backend, each with its supported reasoning efforts (low/medium/high/xhigh/max) selectable via Kimi Code's Thinking control
- **Usage visibility anytime**: `status` shows your 5-hour and weekly window usage with reset times
- **Zero maintenance**: the local bridge server starts itself with each Kimi Code session; tokens refresh automatically
- **Clean uninstall**: one command removes all config, processes, and credentials

## How it works

The plugin runs a tiny OpenAI-compatible server on `127.0.0.1:1456` that translates Kimi Code's requests to ChatGPT's Codex backend:

```
Kimi Code ──▶ local bridge server ──▶ chatgpt.com/backend-api/codex (your subscription)
         ◀── translated streaming ◀──
```

Credentials stay on your machine (`~/.kimi-gpt-bridge/auth.json`, mode 0600) and the server listens on loopback only.

## Requirements

- Node.js ≥ 18 (≥ 24.5 if you need a network proxy)
- A ChatGPT **Plus / Pro** subscription
- Ports **1455** (OAuth callback, only during login) and **1456** (bridge server, override with `KGB_PORT`)

## Quickstart — 4 steps, all inside Kimi Code

```
1. /plugins install https://github.com/devxia/kimi-gpt-bridge
2. /kimi-gpt-bridge:login      # a browser opens for ChatGPT sign-in
3. /kimi-gpt-bridge:setup      # writes the config and syncs the model list
4. /reload, then /model → chatgpt/gpt-5.6-terra
```

From then on the bridge server starts automatically with every session.

## Command reference

| Slash command | CLI equivalent | What it does |
|---|---|---|
| `/kimi-gpt-bridge:login` | `login [--device]` | ChatGPT OAuth login; `--device` for headless machines |
| `/kimi-gpt-bridge:setup` | `setup` | Write/update the provider and model entries in Kimi Code's config |
| `/kimi-gpt-bridge:refresh` | `models sync` | Refresh the model list from ChatGPT (use when new models ship), then `/reload` |
| — | `models list` | Show the live model catalog without changing anything |
| `/kimi-gpt-bridge:status` | `status` | Login state + subscription usage (5-hour / weekly windows) |
| `/kimi-gpt-bridge:start` | `ensure-running` | Start the bridge server manually (rarely needed) |
| — | `serve [--port N]` | Run the server in the foreground (for debugging) |
| — | `proxy [<url>\|off]` | Show / set / clear the network proxy |
| — | `logout` | Delete the stored credentials |
| `/kimi-gpt-bridge:uninstall` | `teardown [--purge]` | Stop the server and remove all config; `--purge` also deletes credentials |

CLI commands run as `node ~/.kimi-code/plugins/managed/kimi-gpt-bridge/src/cli.js <command>`.

## Troubleshooting

**Login fails with `Country, region, or territory not supported` or `fetch failed`**
Your network cannot reach OpenAI directly. The bridge automatically honors the `HTTPS_PROXY` / `HTTP_PROXY` shell environment variables — if your terminal already has them set, no action is needed. If not (e.g. you only have a macOS *system* proxy, which terminal processes can't see), persist your proxy once and retry — login and the server will use it automatically from then on:

```bash
node ~/.kimi-code/plugins/managed/kimi-gpt-bridge/src/cli.js proxy http://127.0.0.1:PORT   # your local HTTP proxy address
```

Proxy resolution order: `KGB_PROXY` env → persisted `config.json` → `HTTPS_PROXY`/`HTTP_PROXY` env.

**429 / usage-limit errors**
A subscription window (5-hour or weekly) is exhausted. The error message tells you when it resets; `status` shows the live numbers.

**Changing reasoning effort**
Use Kimi Code's Thinking control (each model's supported levels are written into the config), or a model-name suffix like `gpt-5.6-terra-high`.

## Uninstall

Order matters — clean the config first, while the plugin's commands still exist:

1. `/kimi-gpt-bridge:uninstall` — stops the server and removes all its entries from `config.toml` (you'll be asked whether to delete the stored credentials too)
2. `/plugins remove kimi-gpt-bridge`, then `/reload`

Two things are not cleaned up automatically: the managed plugin copy that Kimi Code keeps (`~/.kimi-code/plugins/managed/kimi-gpt-bridge/` — safe to delete manually), and the OAuth grant on OpenAI's side (revoke it in your ChatGPT account settings under Connected apps).
