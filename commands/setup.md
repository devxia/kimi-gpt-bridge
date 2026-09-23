---
description: Register the ChatGPT bridge as a provider/model in Kimi Code's config.toml
---

Configure Kimi Code to use the bridge:

1. Run this Bash command. It requires Python 3.11+ with `tomllib` to validate the complete candidate config before replacement.

   ```bash
   node "${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-gpt-bridge/src/cli.js" setup
   ```

   If that path does not exist, locate the kimi-gpt-bridge checkout and run `src/cli.js setup` there.

2. Setup adds a `kimi-gpt-bridge` provider with `api_key = "kimi-gpt-bridge"` when absent and registers new `kimi-gpt-bridge/<slug>` models. When logged in it uses the live catalog; when logged out or the catalog is unavailable it uses the built-in fallback list.

   Existing `chatgpt/<slug>` models are filled in place, not duplicated. When both aliases already exist, the old alias is removed only if it matches plugin-generated defaults exactly and has no main/secondary reference. Existing model/provider values, unknown fields, nested settings, and comments are preserved; only missing fields receive defaults. Existing models absent from the catalog are retained unless explicitly retired. Astra's existing effort and GPT-5.5's custom display name are preserved. The existing provider URL changes only with an explicit `--port` or nonempty `KGB_PORT`.

   Bridge entries are found by TOML identity even if Kimi Code moved them or deleted marker comments. The complete merged candidate is parsed as TOML and installed atomically. Setup does not change main or secondary model selections. Missing or retired model references cause refusal to write, leaving the original file unchanged.

3. Report the generated models, then tell the user to:
   - run `/reload`, and
   - use `/model` to choose a `kimi-gpt-bridge/<slug>` entry, or a preserved `chatgpt/<slug>` entry.

4. If the user is not logged in, suggest login first; afterward they can run the refresh command (`models sync`) to install the live catalog.
