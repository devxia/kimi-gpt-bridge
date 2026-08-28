# AGENTS.md

Pitfalls and hard-won lessons for anyone modifying **kimi-gpt-bridge** (a Kimi Code plugin bridging Kimi Code to a ChatGPT subscription via a local OpenAI-compatible server). Read this before touching the code—every item here was learned the hard way.

## Kimi Code rewrites config.toml—never trust marker comments

Kimi Code re-serializes `config.toml` on some writes: it **hoists `[providers.*]` / `[models.*]` tables into canonical sections and drops comments**, including our markers. A sync that only replaced the marked block once produced a duplicate provider declaration and made Kimi Code fail startup TOML decoding.

- Locate bridge entries **by decoded table identity** (`[providers.kimi-gpt-bridge]`, `[models."chatgpt/<slug>"]`), never by markers alone.
- Parse the complete candidate with a **real TOML parser** before changing the file, then write through a same-directory temporary file and atomic rename. Hand-written table scanning is for ownership/reference discovery, not validation.
- Append the generated block at the **end**: top-level assignments after a table header otherwise belong to that table.
- A refresh that removes a model referenced by `default_model`, `[secondary_model].default_model`, or `[secondary_model.models]` must **refuse the write**. Do not leave Kimi Code with unresolved references.

## Plugin and local API mechanics that surprise

- Plugins cannot register providers or extend `/login`; integration is a `type = "openai"` provider in `config.toml`. `/model` comes from static `[models.*]` entries, not `/v1/models`.
- Generated config deliberately sets `api_key = "kimi-gpt-bridge"`. Generation routes must require exactly `Authorization: Bearer kimi-gpt-bridge`; loopback binding is not a reason to accept arbitrary bearer values.
- OpenAI's default is non-streaming: omitted `stream` and `stream:false` return JSON for both Chat Completions and Responses; only `stream:true` returns SSE. Upstream may still require streaming transport internally.
- Keep the **32 MiB** request-body cap on generation routes. Return a bounded client error rather than buffering without limit.
- Chat SSE must reach `response.completed` or `response.incomplete` before `[DONE]`; streamed Responses must also observe an explicit terminal event. EOF is an error, and early downstream termination must cancel the upstream request/body.
- Lifecycle state is **port-scoped**. Do not reuse a PID record across `KGB_PORT` values, and verify the `/health` service identity before trusting or killing a recorded PID.
- Kimi Code runs the managed copy (`~/.kimi-code/plugins/managed/kimi-gpt-bridge/`). Editing this checkout does not update an installed plugin.
- Slash commands are prompts that invoke Bash, not code. Hooks must always exit 0. Login waits 10 minutes for browser OAuth and 15 minutes for device authorization, so slash-command Bash timeouts must be at least **930 seconds**.
- `/plugins remove` leaves the managed copy on disk; uninstall guidance must account for it.

## Network: proxy env vars only work at process bootstrap

Node fetch reads `NODE_USE_ENV_PROXY` / `HTTPS_PROXY` at process startup. Keep the guarded re-exec; setting proxy variables later in-process does not work.

Proxy order is `KGB_PROXY` → persisted `config.json` → `HTTPS_PROXY`/`HTTP_PROXY`. A macOS system proxy is invisible to terminal processes and still needs `kimi-gpt-bridge proxy <url>`. Any proxy shown in logs or CLI output must redact username/password userinfo.

Browser login succeeding while token exchange reports `Country, region, or territory not supported` or `fetch failed` means the terminal path cannot reach OpenAI. Configure the proxy instead of repeating login.

## Upstream and authentication facts that bite

- **Refresh tokens rotate**. Persist each replacement and serialize refresh across Node processes with the auth-file lock. Logout/auth deletion must use the same mutation lock so it cannot race an in-flight refresh.
- Use catalog `context_window`, not `max_context_window`; over-declaring causes compaction after the subscription path's accepted window.
- `ultra`, `off`, and `none` stay filtered. `max` is a supported effort and must remain accepted in catalog config, explicit `reasoning_effort`, and model suffix parsing.
- OAuth callback port **1455** is allow-listed and fixed. Browser callback timeout is 10 minutes; device polling timeout is 15 minutes.
- Upstream request shape is mandatory: `store:false, stream:true, include:["reasoning.encrypted_content"]`. Preserve supported tool-selection/parallel-call constraints.
- Encrypted reasoning belongs immediately before the matching function calls on the adjacent tool continuation. Return portable reasoning metadata when possible; keep any cache fallback bounded, conversation-scoped, adjacent-only, and one-shot.
- On 401, force-refresh once and retry once. Surface 429 reset information; never loop retries.

## Testing / workflow

- The project has **zero npm runtime dependencies**; use Node built-ins. Config mutation deliberately invokes the system `python3` / `tomllib` as the independent TOML parser rather than adding an npm parser dependency.
- `npm test` must stay fully offline: inject `fetchImpl`, isolate `KGB_HOME`/`KIMI_CODE_HOME`, and never contact OpenAI or ChatGPT.
- Config-writing tests must invoke a real TOML parse; generated text that merely looks valid is insufficient.
- Cover request limits, exact local bearer auth, stream/non-stream defaults, terminal SSE/error cancellation, cross-process refresh/logout locking, invalid-reference refusal, port-scoped PID identity, proxy redaction, and `max` effort behavior.
