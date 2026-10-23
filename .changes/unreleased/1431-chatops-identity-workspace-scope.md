---
issue: 1431
section: Security
---

- A workspace admin can link a Teams or Slack account only to a member of that
  workspace (by id or by email). Linking anyone else gets the same 404 as an
  unknown user. Before, an admin could link their own Teams account to a user
  in another workspace, or to a system admin, and run `/metis` commands as them.
- A member who is a system admin can be linked only by a system admin.
- Links are now per workspace (a migration changes the unique key on both
  schemas), so one workspace can no longer overwrite or unlink another
  workspace's link. At command time a link works only in its own workspace and
  only while the user is still a member. Otherwise the command is refused.
