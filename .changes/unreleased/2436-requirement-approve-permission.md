---
issue: 2436
section: Security
---

- Approving or rejecting a requirement directly (the Requirements list, the requirement card,
  and the API) needs the new `requirement.approve` permission instead of `project.update`.
  Coordinators and admins hold it, as before, so no role gains or loses anything.
- Maker-checker: you cannot approve a requirement you wrote or edited, and you cannot sign off a
  review you requested. A coordinator or admin can switch on **Allow self-approval** for a
  project (Publishing → Approval gate) for a team of one. It is off by default, and each change
  of the setting and each self-approval is recorded in the audit log.
