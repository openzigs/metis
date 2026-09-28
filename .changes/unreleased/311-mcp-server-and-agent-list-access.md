---
issue: 311
section: Security
---

- An MCP server that belongs to a project can now be viewed, edited, deleted, started, stopped,
  tested, or have its tools, integrity snapshot or governance changed only by someone who can
  reach that project. A server in another workspace's project answers "not found", and the MCP
  server list and `mcp.json` export no longer include such servers. Global servers are unchanged.
- Listing a project's custom agents now checks that you can reach the project; another
  workspace's project answers "not found" (also reported as #288).
