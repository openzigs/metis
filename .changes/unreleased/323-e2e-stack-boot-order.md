---
issue: 323
section: Fixed
---

- The Playwright e2e stack migrates its test database before the API server
  starts, so boot-time reads no longer run against a missing database.
- The e2e UI server runs `next dev --webpack`, like the UI `dev` script, so a
  Turbopack panic can no longer kill it mid-suite (#342).
- The e2e config no longer sets `INGEST_QUEUE=off`, which the server never
  read. e2e ingest is queued, as it is in production (#332).
