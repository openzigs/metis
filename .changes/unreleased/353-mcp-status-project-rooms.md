---
issue: 353
section: Security
---

- A project MCP server's status events (its label, status and last error) now reach only people who can access that project: members of the project's workspace and system admins. Before, every holder of the MCP-manage permission in every workspace received them. Projects not yet assigned to a workspace stay visible to everyone, as they are elsewhere in the app. Global server events are unchanged.
- Workspace membership is read from the sign-in token your live connection was opened with, so a workspace added or removed takes effect when that connection reconnects; re-opening the MCP status feed on the same connection keeps the rooms it already had.
