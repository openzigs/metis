---
issue: 2335
section: Added
---

- A repository's index can now keep itself current: point a GitHub push webhook at
  `/api/webhooks/github/push` (the server's shared secret) or
  `/api/webhooks/github/push/c/<connection id>` (the connection's own secret), and a push to
  the branch the connection tracks starts an incremental sync in the background. Pushes to
  other branches, tag pushes and branch deletions are ignored. A CI job or git hook on a host
  that cannot send webhooks can send the same signed request; the User Guide (section 15.4)
  has the example.
- Clicking **Sync** while a sync is already running for that repository no longer fails: the
  sync is queued and runs when the current one finishes. However many are asked for during one
  run (clicks, pushes, the schedule), exactly one more runs after it, and a failed follow-up
  is not retried on its own. The scheduled refresh queues the same way instead of failing.
