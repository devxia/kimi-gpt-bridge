---
description: Start the local bridge server if it is not already running
---

Start the bridge server:

1. Run this Bash command:

   ```bash
   node "$KIMI_CODE_HOME/plugins/managed/kimi-gpt-bridge/src/cli.js" ensure-running
   ```

   If that path does not exist, locate the kimi-gpt-bridge repo checkout and run `src/cli.js ensure-running` from there.

2. Verify the server is healthy:

   ```bash
   curl -s http://127.0.0.1:1456/health
   ```

3. Report the result. If `authed` is false in the health response, tell the user to run the login command. If the server failed to start, check `~/.kimi-gpt-bridge/server.log` for errors.
