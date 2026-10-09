---
issue: 738
section: Fixed
---

- `/sessions` rows show each session's project (linked) and when it was last active.
- `GET /api/ai/sessions` without `?status=resumable` lists the caller's own sessions,
  newest first and paged (`limit`, `offset`, `page.hasMore`), instead of always `[]`.
