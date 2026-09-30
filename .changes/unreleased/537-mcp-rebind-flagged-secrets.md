---
issue: 537
section: Fixed
---

- An MCP server whose vault references the #504 backfill could not bind now
  says so on its row in Settings → MCP servers, names the references, and offers
  **Re-bind secrets**. Before, the only sign was an audit entry and a failed
  connect, and the documented fix (save the server again) had no UI path. The
  re-bind follows the usual secret rule: it succeeds for the user who created
  those secrets or an admin, and explains the refusal to anyone else — so a
  server imported from mcp.json before secrets recorded their owner needs an
  admin.
- Saving such a server again no longer binds a flagged reference for someone
  who could not attach that secret directly.
