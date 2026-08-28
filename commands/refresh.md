---
description: Refresh the model list from ChatGPT
---

Refresh the ChatGPT models registered in Kimi Code's `config.toml`:

1. Run this Bash command. It requires Python 3.11+ with `tomllib` for independent candidate-config validation.

   ```bash
   node "${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-gpt-bridge/src/cli.js" models sync
   ```

   If that path does not exist, locate the kimi-gpt-bridge checkout and run the same `models sync` command there.

2. This requires login. If it reports "Not logged in", run login and retry. Use `models list` to inspect the catalog without changing config.

3. Sync validates the complete candidate with a real TOML parser and replaces config atomically. If the new catalog would remove a `chatgpt/...` model still used by `default_model`, `[secondary_model].default_model`, or `[secondary_model.models]`, it refuses to overwrite config. Report those references and tell the user to choose valid models before retrying.

4. On success, report model slugs, efforts (including `max` when advertised), and context sizes. Tell the user to run `/reload` and check `/model`.
