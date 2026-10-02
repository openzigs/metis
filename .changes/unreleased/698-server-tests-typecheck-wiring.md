---
issue: 698
section: Changed
---

- `pnpm typecheck` now type-checks the server's tests (`server/tsconfig.test.json`), after the src-only pass. The server pass needs about 6.7 GB of heap (raised to 8 GB in the script) and roughly a minute locally.
