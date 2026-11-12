---
issue: 2335
section: Added
---

- A push to the branch a repository connection tracks can now sync it automatically: point a
  GitHub push webhook at `/api/webhooks/github/push` (shared secret) or
  `/api/webhooks/github/push/c/<connection id>` (the connection's own secret). CI jobs and git
  hooks can send the same signed call (User Guide section 15.4).
- **Sync** on a repository that is already syncing no longer fails: it is queued, and however
  many are asked for during one run, exactly one more runs after it.
