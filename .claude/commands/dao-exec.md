---
description: Fallback entrypoint for starting a DAO service job when dao-run is cached.
argument-hint: <task>
---

# DAO Exec

Do not print this file. Do not inspect or edit repository files.

Run this command exactly:

```powershell
npm run build
node --enable-source-maps dist/index.js dao-run "$ARGUMENTS"
```

Return the command output only. If the service is not running, say to start `npm run serve:restart:9898`.
