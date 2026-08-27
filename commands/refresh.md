---
description: refresh the model list from ChatGPT
---

Refresh the ChatGPT models registered in Kimi Code's config.toml:

1. Run this Bash command:

   ```bash
   node "$KIMI_CODE_HOME/plugins/managed/kimi-gpt-bridge/src/cli.js" models sync
   ```

   If that path does not exist, locate the kimi-gpt-bridge repo checkout (look for `src/cli.js`) and run the same `models sync` command from there.

2. This requires being logged in. If it fails with "Not logged in", run the login command first, then retry. To just look at the live catalog without changing config, run `models list` instead.

3. Report the synced models (slug, efforts, context) to the user, then tell them to:
   - run `/reload` to pick up the new config, and
   - check `/model` — the models appear as `chatgpt/<slug>`.
