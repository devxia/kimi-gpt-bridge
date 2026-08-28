---
description: Start the local bridge server if it is not already running
---

Start the bridge server:

1. Run this Bash command. It uses `KGB_PORT`, defaulting to 1456.

   ```bash
   node "${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-gpt-bridge/src/cli.js" ensure-running
   ```

   If that path does not exist, locate the kimi-gpt-bridge checkout and run `src/cli.js ensure-running` there.

2. Verify health on the same configured port:

   ```bash
   PORT="${KGB_PORT:-1456}"
   curl -s "http://127.0.0.1:${PORT}/health"
   ```

3. Report the result only if the health payload identifies `kimi-gpt-bridge`. If `authed` is false, tell the user to run login. If startup or identity verification fails, do not treat an unrelated listener as the bridge; inspect `~/.kimi-gpt-bridge/server.log`.
