---
issue: 2331
section: Added
---

- **Query the METIS index from your own agent.** `metis-index-mcp`, a stdio MCP server, gives
  Claude Code, Cursor or Claude Desktop eight read-only `metis_*` tools that run chat's own
  searches, with citations; METIS makes no model call. Setup: `docs/integrations/metis-index-mcp.md`.
- **Every call runs as you**, on your own METIS API token (`acp:read`), checked on every call. You
  see only the projects and files you can read; a requirement's link into a restricted file is
  counted, never named (chat's `get_requirement` too). Results are redacted and audit-logged.
- **A disabled or deleted user's API token is refused everywhere**, including ACP's WebSocket.
