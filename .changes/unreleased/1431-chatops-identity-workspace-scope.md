---
issue: 1431
section: Security
---

- A Teams or Slack account can be linked only to a member of the linking workspace (a system-admin member only by a system admin). Anyone else gets the unknown-user 404. Before, an admin could link their own Teams account to a user in another workspace, or to a system admin, and run `/metis` commands as that user.
- Links are kept per workspace (a migration on both schemas), so one workspace can't overwrite or unlink another's. A link works only in its own workspace, and only while the user is still a member.
- Upgrade note: after upgrading, people linked only in another workspace, and links naming a non-member, see "Account not linked" until a workspace admin links them again. Review existing links to system-admin members, which still work.
