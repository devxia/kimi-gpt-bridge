---
description: Stop the bridge server and remove its Kimi Code config (optionally delete credentials)
---

Uninstall the bridge:

1. Ask the user whether stored credentials should also be deleted. If yes, add `--purge`; if no (or no answer), omit it.

2. Run this Bash command. Removing bridge tables requires Python 3.11+ with `tomllib` to validate the candidate config before replacement.

   ```bash
   node "${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-gpt-bridge/src/cli.js" teardown
   ```

   or, with credential deletion:

   ```bash
   node "${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-gpt-bridge/src/cli.js" teardown --purge
   ```

   If that path does not exist, locate the kimi-gpt-bridge repo checkout and run `src/cli.js teardown` from there.

3. This checks each port-scoped PID record and stops only processes whose port and PID match the bridge's verified health identity, then atomically removes bridge-owned provider/model tables from `config.toml`. If it warns that `default_model` or `secondary_model` settings still point to `chatgpt/...` models, relay those warnings prominently and suggest choosing new models with `/model` (and `/secondary-model`)—unresolved references make Kimi Code fail startup validation.

4. Then instruct the user to run `/plugins remove kimi-gpt-bridge` in Kimi Code, followed by `/reload`.

5. After the plugin is removed, mention the two remaining leftovers and offer to clean the first one:
   - Kimi Code keeps the managed plugin copy at `${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-gpt-bridge/` even after `/plugins remove` (documented Kimi Code behavior). Offer to delete it: `rm -rf "${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-gpt-bridge"`.
   - Local credential deletion does NOT revoke the OAuth grant at OpenAI. If the user wants to revoke it, point them to their ChatGPT account settings (Security / Connected apps) to remove the Codex authorization.
