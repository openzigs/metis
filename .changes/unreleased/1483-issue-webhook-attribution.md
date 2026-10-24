---
issue: 1483
section: Security
---

- GitHub issue events get a per-connection receiver, `/api/webhooks/github/issues/c/<connection id>`, signed with the connection's own webhook secret and acting on that project only. A project with its own secret no longer takes shared-secret issue deliveries: move its issue webhooks to the new URL shown on the connection card.
- Spec Kit `tasks.md` sync and drift detection pick the earliest matching row in a live project, never a deleted one.
- The issue and pull-request receivers read the event from the signed body, not the `X-GitHub-Event` header, so a body captured at one receiver does nothing at the other.
