---
issue: 1710
section: Fixed
---

- `pnpm --filter @metis/server db:gen-postgres` and `db:gen-postgres:check`
  work again. The generator script resolved the schema paths against the
  caller's working directory, so the documented command (which pnpm runs from
  `server/`) exited with "not found — run from repo root". It now resolves
  them from its own location and runs from any directory.
