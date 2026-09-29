---
issue: 340
section: Security
---

- A personal (`user`-scope) MCP server is reachable only by its owner and system admins: by-id routes answer others "not found", lists, exports and the agent tool list (`/api/ai/tools`) show a non-admin only their own, its status events reach only the owner and admins, and chat tools refuse it with the generic "not ready" message.
- `/api/runs/:id*` answers **404 `RUN_NOT_FOUND`** (was `403 FORBIDDEN`) for a run you cannot reach, the same as an unknown id. Operator note: scripts that checked for 403 now get 404.
- Editing or deleting a trigger through another project's URL, or scheduling autopilot for another workspace's project, answers "not found" and changes nothing.
