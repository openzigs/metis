---
issue: 258
section: Fixed
---

- Reinstalling Slack, Teams or PagerDuty after an uninstall, re-importing a
  source or `mcp.json`, updating MCP, test-management or suggested-connector
  credentials, and re-using a deleted Jira or test-management connection's label
  no longer fail with a 500 on a name held by a deleted secret or connection.
  An `mcp.json` re-import no longer reports success while the server keeps the
  old secret, and the vault page answers 409 for a label that is already taken.
