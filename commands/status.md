---
description: Show bridge auth state, token expiry, and ChatGPT account/plan info
---

Check the bridge status:

1. Run this Bash command:

   ```bash
   node "$KIMI_CODE_HOME/plugins/managed/kimi-gpt-bridge/src/cli.js" status
   ```

   If that path does not exist, locate the kimi-gpt-bridge repo checkout and run `src/cli.js status` from there.

2. Summarize the output for the user: whether they are logged in, the account email, plan type, and access-token expiry. If it reports "Not logged in", suggest running the login command.
