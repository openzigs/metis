---
issue: 449
section: Changed
---

- When a repository ingest succeeds but scheduling automatic document regeneration fails, the
  ingest now reports success with a warning instead of an error. The manual Sync
  (`POST …/refresh-ingest`) answers `200` with its summary, `regenerationScheduled: false` and a
  `warning` rather than `500 REGENERATION_SCHEDULING_FAILED`, and the Connections page shows that
  warning. Deep Ingest completes the job with the warning (amber) instead of failing it, and a
  scheduled refresh completes rather than failing.
- The failed scheduling step is retried on its own by a durable `schedule-regeneration` task, so
  a retry no longer repeats the whole pull and ingest.
