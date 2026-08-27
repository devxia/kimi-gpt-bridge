---
description: Register the ChatGPT bridge as a provider/model in Kimi Code's config.toml
---

Configure Kimi Code to use the bridge:

1. Run this Bash command:

   ```bash
   node "$KIMI_CODE_HOME/plugins/managed/kimi-gpt-bridge/src/cli.js" setup
   ```

   If that path does not exist, locate the kimi-gpt-bridge repo checkout and run `src/cli.js setup` from there.

2. This writes a `kimi-gpt-bridge` provider plus one `chatgpt/<slug>` model entry per available ChatGPT model to `config.toml`. When logged in, setup syncs the live model list from ChatGPT; otherwise (or on network failure) it writes a built-in fallback list. If a bridge block already exists between the `# >>> kimi-gpt-bridge >>>` markers, it is replaced in place. It does not change `default_model`.

3. Then tell the user to:
   - run `/reload` to pick up the new config, and
   - switch model via `/model` to one of the `chatgpt/<slug>` entries (the first one printed by setup is the most prominent).

4. If the user has not logged in yet, suggest running the login command first — after login they can refresh the live model list with the refresh command (`models sync`).
