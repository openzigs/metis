---
issue: 495
section: Security
---

- A PATCH to a Jira or test-management connection or an MCP server that fails with 409
  `CONCURRENT_UPDATE` no longer leaves a new vault secret behind. The record is compared with the
  one the secret-binding check read before any credential is written, and secrets written by a
  request whose update then fails are withdrawn.
- A replaced credential is no longer retired while a pending, running, failed or cancelled
  scheduled task still names it in its payload, so retrying that task can still read the secret.
