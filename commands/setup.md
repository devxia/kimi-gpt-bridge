---
description: Register the ChatGPT bridge as a provider/model in Kimi Code's config.toml
---

Configure Kimi Code to use the bridge:

1. Run this Bash command. It requires Python 3.11+ with `tomllib` to validate the complete candidate config before replacement.

   ```bash
   node "$KIMI_CODE_HOME/plugins/managed/kimi-gpt-bridge/src/cli.js" setup
   ```

   If that path does not exist, locate the kimi-gpt-bridge checkout and run `src/cli.js setup` there.

2. Setup writes a `kimi-gpt-bridge` provider with `api_key = "kimi-gpt-bridge"` plus one `chatgpt/<slug>` table per model. When logged in it syncs the live catalog; when logged out or the catalog is unavailable it uses the built-in fallback list.

   Existing bridge entries are found by TOML table identity even if Kimi Code moved them or deleted marker comments. The complete candidate config is parsed as TOML and installed atomically. Setup does not change `default_model`.

3. Report the generated models, then tell the user to:
   - run `/reload`, and
   - use `/model` to choose a `chatgpt/<slug>` entry.

4. If the user is not logged in, suggest login first; afterward they can run the refresh command (`models sync`) to install the live catalog.
