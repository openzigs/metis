---
issue: 258
section: Fixed
---

- Reinstalling Slack, Teams or PagerDuty after an uninstall, re-importing a
  source or `mcp.json`, updating MCP or suggested-connector credentials, and
  re-using a deleted Jira connection's label
  no longer fail with a 500 on a name held by a deleted secret or connection.
  An `mcp.json` re-import no longer reports success while the server keeps the
  old secret, and the vault page answers 409 for a label that is already taken.
