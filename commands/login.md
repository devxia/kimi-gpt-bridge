---
description: Log in to ChatGPT (Plus/Pro) via OAuth so the bridge can use your subscription
---

Run the bridge's OAuth login flow:

1. Run this as a foreground Bash command with a timeout of at least 930 seconds. The CLI waits up to 10 minutes for browser OAuth; the device flow waits up to 15 minutes.

   ```bash
   node "$KIMI_CODE_HOME/plugins/managed/kimi-gpt-bridge/src/cli.js" login
   ```

   If that path does not exist, locate the kimi-gpt-bridge checkout (look for `src/cli.js`) and run the same command there.

2. Tell the user that a browser window will open and they should complete ChatGPT sign-in. If no browser opens, they can open the printed URL in a browser on this machine because the callback uses localhost.

3. When the command finishes, report the account email and plan type.

4. If no browser is available or port 1455 cannot be bound, re-run the following foreground command with the same timeout of at least 930 seconds:

   ```bash
   node "$KIMI_CODE_HOME/plugins/managed/kimi-gpt-bridge/src/cli.js" login --device
   ```

   Device login works on headless machines and expires after 15 minutes.
