---
issue: 655
section: Security
---

- Following a connector's, a background run's or a job's live events (`subscribe:connector`,
  `subscribe:bg-run`, `subscribe:job`) now requires access to what the room is about, the same
  rule as reading it over the API. A user outside its project, or one naming an unknown id,
  receives `auth:error` and no events — previously any signed-in user could follow any of these
  rooms by id, and PR-review job ids are sequential.
- A job with no project (a PR review from a webhook with none) can be followed by admins only;
  an impact analysis by anyone who can open it.
- A refused join names its room, and the UI drops that room quietly instead of showing an error,
  so a job the server forgot after a restart no longer raises a toast on every reconnect.
