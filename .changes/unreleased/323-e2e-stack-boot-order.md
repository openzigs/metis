---
issue: 323
section: Fixed
---

- The Playwright e2e stack migrates its test database before the API server
  starts. The API used to boot against a data directory that did not exist yet,
  so its boot-time reads (runtime settings, vault secrets, the recovery sweeps)
  never ran against a database in e2e. A stale `stack-data/` left by an earlier
  run could also make every write fail with "attempt to write a readonly
  database".
- The e2e UI server runs `next dev --webpack`, like the UI package's `dev`
  script. A Turbopack panic had killed it mid-suite and failed every later spec
  (#342).
- The e2e config no longer sets `INGEST_QUEUE=off`. The server never read that
  setting, and e2e ingest is queued, as it is in production (#332).
