---
issue: 591
section: Security
---

- A vault credential replaced by someone other than its owner, but kept because something still
  referenced it — typically a failed or cancelled webhook task inside its 7-day retry window — is
  now re-checked every hour and retired once nothing references it any more. Each retirement is
  audited as `vault.delete` by `system`. Previously such a credential stayed live for ever after
  the task's window had passed. A credential still used by a live connector, MCP server, chat
  session or scheduled job is never retired.
