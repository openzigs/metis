---
issue: 432
section: Fixed
---

- A Deep Ingest that completes with failures now shows an amber warning banner and a warning toast
  on the Connections page instead of the green success styling. The job's completion event carries
  the failure count, so the page no longer has to infer it from the message.
- A scheduled repository refresh whose ingest succeeds but whose regeneration scheduling fails no
  longer reads as a failed ingest. The task is still marked failed, so it retries, but its message
  now says the repository was ingested and only the scheduling failed. The manual Sync (refresh-ingest) request reports the same case with its
  own error code, and it now sends the discovered-connections notification before scheduling, so a
  scheduling failure no longer hides it.
