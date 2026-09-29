---
issue: 340
section: Security
---

- A personal (`user`-scope) MCP server is reachable only by its owner and system admins; anyone
  else gets "not found", lists and exports show only your own, and chat tools refuse another
  user's server. Operator note: `MCP_ALLOW_USER_SCOPE` still defaults to off, and it is safe to
  leave it off.
- `/api/runs/:id*` answers **404 `RUN_NOT_FOUND`** (was `403 FORBIDDEN`) for a run you cannot
  reach, the same as an unknown id. Operator note: scripts that checked for 403 now get 404.
- Editing or deleting a trigger through another project's URL, or scheduling autopilot for another
  workspace's project, answers "not found" and changes nothing.
