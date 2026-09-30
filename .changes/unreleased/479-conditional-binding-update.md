---
issue: 479
section: Security
---

- Behaviour change: a PATCH to a DB or repo connector, a Jira or test-management connection, or an
  MCP server now fails with 409 `CONCURRENT_UPDATE` when the record changed between the vault
  secret-binding check and the write. Two concurrent edits could previously interleave and leave a
  secret someone else supplied at a destination the caller chose. Reload the record and retry.
