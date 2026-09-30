---
issue: 561
section: Security
---

- Removing a member from a workspace now revokes the access that membership granted, even on
  a session that started before the removal. The removed user can no longer open or list the
  workspace's projects, and refreshing the session no longer carries the old membership
  forward. (Live MCP status events still follow the session's original workspaces until #562.)
