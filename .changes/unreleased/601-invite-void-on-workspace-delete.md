---
issue: 601
section: Security
---

- Deleting a workspace now cancels its outstanding invitations in the same step, so an
  invitation accepted at the moment the workspace is deleted can no longer add a member to it
  on Postgres. Such an invitation is refused with "This workspace no longer exists".
