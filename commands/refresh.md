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

3. Sync adds new models and fills missing fields, preserving existing model/provider settings, custom names, nested fields, and comments. Existing models omitted from the current catalog stay configured; only explicitly retired models such as GPT-5.4-Mini are removed. Astra's configured effort is preserved, and GPT-5.5's Legacy name replaces only a missing or old stock name. The provider URL is preserved unless `--port` or nonempty `KGB_PORT` explicitly overrides it.

4. Sync validates the complete merged candidate with a real TOML parser and replaces config atomically. Main/secondary references are checked against that merged result. If `default_model`, `[secondary_model].default_model`, or `[secondary_model.models]` references a missing or retired model, it refuses to write. Report those references and tell the user to choose valid models before retrying.

5. On success, report catalog model slugs, efforts (including `max` when advertised), and context sizes. Explain that existing custom settings take precedence over catalog defaults; do not present the catalog output as proof that existing settings were overwritten. Tell the user to run `/reload` and check `/model`.
