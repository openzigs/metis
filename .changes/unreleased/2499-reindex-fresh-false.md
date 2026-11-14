---
issue: 2499
section: Fixed
---

- Sending `{"fresh": "false"}` to `POST /api/admin/embeddings/projects/:projectId/reindex`
  resumes an interrupted reindex, instead of discarding the surviving shadow and
  re-embedding from scratch. `fresh` now takes `true`/`false`, `1`/`0`, `yes`/`no`,
  `on`/`off` or a JSON boolean; any other value is refused with
  `400 INVALID_BODY`. The admin UI sent a JSON boolean and was not affected.
