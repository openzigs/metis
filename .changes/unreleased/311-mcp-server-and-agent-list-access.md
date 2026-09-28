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
- A project-scoped MCP server must now name its project: every create, import and install path
  refuses one without a `projectId` (`400 PROJECT_REQUIRED`), and the Settings registry install
  is global-only. An existing project server with no project is now available to no project
  (it was available to all) until an admin, who still lists it, deletes it and re-registers it.
