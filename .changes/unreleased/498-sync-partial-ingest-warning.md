---
issue: 498
section: Fixed
---

- A Sync (`POST …/refresh-ingest`) whose source-file or metadata ingest partly failed no longer
  reads as "Sync complete". It now returns a `failureCount` and a `warning` naming the failures,
  as Deep Ingest does, and the Connections page shows "Sync finished with a warning".
- The Sync warning is announced to screen readers once (by the toast) instead of twice.
- The `schedule-regeneration` retry now takes the connector's ingest lease, so it never runs in
  the middle of a later Sync or Deep Ingest; while one is running it stands down, since that
  ingest schedules regeneration itself.
