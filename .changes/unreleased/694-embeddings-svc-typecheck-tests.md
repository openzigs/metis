---
issue: 694
section: Fixed
---

- `pnpm typecheck` now type-checks the embeddings sidecar's tests (`server/embeddings-svc/tests/**`) through a `noEmit` `tsconfig.test.json`; previously its tsconfig excluded them, so a type error in a test could reach `main` unnoticed. `build` output is unchanged.
