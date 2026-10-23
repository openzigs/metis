---
issue: 1437
section: Security
---

- Teams and Slack `/metis` commands act only on projects in the bot's (or Slack install's) workspace. `status`, `approve` (prompt and button), Teams promote and Teams channel sync refuse a project, draft or thread elsewhere with the same reply an unknown one gets, even for a user who belongs to both workspaces or is a system admin.
- Upgrade note: `/metis status` for a project without a workspace, and a linked channel whose project has since moved to another workspace, are now refused. Move the project into the bot's workspace, or link the channel again.
