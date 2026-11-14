---
issue: 2331
section: Added
---

- **Query the METIS index from your own agent.** `metis-index-mcp`, a stdio MCP server, gives
  Claude Code, Cursor or Claude Desktop eight read-only `metis_*` tools: code context, symbols,
  callers and callees, file slices, requirements, index status and your projects. They run
  chat's own searches, with citations; METIS makes no model call.
- **Every call runs as you**, on your own METIS API token (`acp:read`), checked on every call. A
  shared or revoked token is refused, and you see only what you can read in METIS: projects and
  restricted files alike. Results are redacted for secrets and calls are audit-logged without
  results. Setup: `docs/integrations/metis-index-mcp.md`.
