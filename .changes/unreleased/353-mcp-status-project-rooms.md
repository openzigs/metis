---
issue: 353
section: Security
---

- A project MCP server's status events (its label, status and last error) now reach only people who can access that project: members of the project's workspace and system admins. Before, every holder of the MCP-manage permission in every workspace received them. Projects not yet assigned to a workspace stay visible to everyone, as they are elsewhere in the app. Global server events are unchanged.
- Workspace membership is read from your sign-in token when you open the MCP status feed, so a membership change takes effect the next time the token is refreshed and the feed is re-opened.
