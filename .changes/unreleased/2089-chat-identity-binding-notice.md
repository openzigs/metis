---
issue: 2089
section: Security
---

- Linking a Microsoft Teams account to a workspace member is no longer silent. That link
  lets the Teams account run commands as the member, and a workspace admin can link any
  member, the owner included. Each link now writes an audit entry: who made it, the
  workspace, the member and the Teams account. It also tells the workspace owner, and the
  linked member unless they made the link themselves, in their notifications. Notification
  settings cannot turn this notice off. No MFA sign-in is required to make a link: that is
  the workspace owner's decision.
