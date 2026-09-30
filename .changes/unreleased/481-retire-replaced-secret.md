---
issue: 481
section: Security
---

- When a user replaces Jira or test-management credentials that another user supplied, the
  previous vault secret is now soft-deleted, provided no DB or repo connector, MCP server, publish
  batch or other Jira / test-management connection still references it (audited as
  `vault.secret_retired`). A secret that is still referenced is left alone.
