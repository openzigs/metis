---
issue: 1239
section: Changed
---

- A member cancelling or retrying a task is now audited as `task.cancel.requested` / `task.retry.requested`, so `task.cancel` and `task.retry` each name one event and one cancel no longer counts twice in an audit export.
