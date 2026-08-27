---
description: Log in to ChatGPT (Plus/Pro) via OAuth so the bridge can use your subscription
---

Run the bridge's OAuth login flow:

1. Run this as a foreground Bash command with a 300s timeout:

   ```bash
   node "$KIMI_CODE_HOME/plugins/managed/kimi-gpt-bridge/src/cli.js" login
   ```

   If that path does not exist, locate the kimi-gpt-bridge repo checkout (look for `src/cli.js`, e.g. under the directory where the user cloned it) and run the same command from there.

2. Tell the user that a browser window will open for ChatGPT login, and that they should complete the sign-in there. If no browser opens, they can copy the URL printed in the output into any browser (even on another machine is not possible — the callback is on localhost, so it must be a browser on this machine).

3. When the command finishes, report the resulting account email and plan type to the user.

4. If the flow fails because no browser is available or port 1455 cannot be bound, suggest re-running with the `--device` flag (device-code flow, works on headless machines) or running the command manually in a terminal:

   ```bash
   node "$KIMI_CODE_HOME/plugins/managed/kimi-gpt-bridge/src/cli.js" login --device
   ```
