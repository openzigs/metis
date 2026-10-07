---
issue: 481
section: Security
---

- When a user replaces Jira credentials that another user supplied, the
  previous vault secret is now soft-deleted, provided no DB or repo connector, MCP server, publish
  batch, chat session BYOK key, scheduled webhook or other Jira connection
  still references it (audited as
  `vault.secret_retired`). A secret that is still referenced is left alone.
