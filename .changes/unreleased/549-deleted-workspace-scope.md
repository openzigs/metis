---
issue: 549
section: Security
---

- Deleting a workspace now revokes the access its membership granted. Members of a deleted
  workspace can no longer open, list or search its projects, manage its members or settings,
  or reach it through API tokens, even with a session that started before the delete.
  (Live MCP status events still follow the session's original workspaces until #562.)
