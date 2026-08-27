# AGENTS.md

Pitfalls and hard-won lessons for anyone modifying **kimi-gpt-bridge** (a Kimi Code plugin bridging Kimi Code to a ChatGPT subscription via a local OpenAI-compatible server). Read this before touching the code — every item here was learned the hard way.

## Kimi Code rewrites config.toml — never trust marker comments

Kimi Code re-serializes `config.toml` on some writes: it **hoists `[providers.*]` / `[models.*]` tables into its own canonical sections and drops all comments**, including our `# >>> kimi-gpt-bridge >>>` markers. A sync that only replaced the marked block once produced a duplicate `[providers.kimi-gpt-bridge]` declaration, which makes Kimi Code fail at startup with `failed to decode config.toml as toml`.

- Always locate bridge entries **by table identity** (`[providers.kimi-gpt-bridge]`, `[models."chatgpt/<slug>"]`), never by markers alone — see `stripBridgeTables()` in `src/models.js`.
- Appended TOML blocks must go at the **end** of the file (top-level scalars after a `[table]` header would be parsed into that table).
- Kimi Code config validation **fails loudly**: an unresolved `default_model` / `secondary_model` reference breaks session startup. `teardown` must warn about these (it does).

## Plugin mechanics that surprise

- Kimi Code plugins **cannot register providers or extend `/login`**; the only integration surface is a `type = "openai"` provider in `config.toml` pointing at the local server. The `/model` list comes from static `[models.*]` config entries — the server's `/v1/models` route is **not** what populates it.
- Kimi Code runs the **managed copy** (`~/.kimi-code/plugins/managed/kimi-gpt-bridge/`). Editing this repo has **no effect** on an installed plugin until the files are copied over or the plugin is reinstalled. During development, sync every changed file and `diff`-verify.
- Plugin slash commands are just prompts telling the agent to run a CLI subcommand via Bash — they are not code. Hooks must **always exit 0** (they run inside session startup).
- `/plugins remove` deletes only the installation record; the managed copy stays on disk. Uninstall flows must account for that.

## Network: proxy env vars only work at process bootstrap

Node's fetch (undici) reads `NODE_USE_ENV_PROXY` / `HTTPS_PROXY` **only at process startup** — setting `process.env` in-process does nothing. Hence `reexecWithProxyIfNeeded()` in `src/proxy.js` (guarded by `KGB_REEXEC`). Don't try to "fix" this by setting env vars at runtime.

Proxy resolution order is `KGB_PROXY` env → persisted `config.json` → `HTTPS_PROXY`/`HTTP_PROXY` shell env (the conventional fallback, so proxied shells need zero setup). macOS **system** proxy is invisible to terminal processes — that's the case that still needs `kimi-gpt-bridge proxy <url>`.

Symptom-to-cause: browser login succeeds but token exchange fails with `Country, region, or territory not supported` or `fetch failed` → the **terminal's** network can't reach OpenAI (browser used the system proxy; Node didn't). Fix is `kimi-gpt-bridge proxy <url>`, not re-login.

## Upstream (ChatGPT Codex backend) facts that bite

- **Refresh tokens rotate**: always persist the new `refresh_token` from a refresh response. Concurrent refreshes must share one in-flight request (`token-store.js` mutex) — a reused rotated token permanently kills the chain and forces re-login.
- **Context window**: use the catalog's `context_window` (272k). `max_context_window` (872k/1M) is the model's hard capacity and is **not** honored on the Codex subscription path; pi and Codex CLI both use `context_window`. Over-declaring makes Kimi Code compact too late and requests past 272k fail upstream.
- Reasoning tiers `ultra` / `off` are deliberately filtered out (`EXCLUDED_EFFORTS` in `src/models.js`) — keep that filter on every catalog refresh path.
- OAuth callback port **1455 is allow-listed by OpenAI** and cannot be made configurable; on bind failure fall back to manual paste (already implemented).
- Request shape is mandatory: `store:false, stream:true, include:["reasoning.encrypted_content"]`. A 401 means force-refresh once and retry; a 429 carries `resets_at` — surface it, never auto-retry in a loop.

## Testing / workflow

- `npm test` must stay **fully offline** — inject `fetchImpl`, point `KGB_HOME`/`KIMI_CODE_HOME` at temp dirs, never hit `auth.openai.com`/`chatgpt.com` from tests.
- Verify config-writing changes with a real TOML parse (e.g. `python3 -c "import tomllib; tomllib.load(...)"`) — eyeballing generated TOML has failed us before.
