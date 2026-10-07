---
issue: 495
section: Security
---

- A PATCH to a Jira connection or an MCP server that loses the race and fails
  with 409 `CONCURRENT_UPDATE` no longer leaves a new vault secret behind. The record is compared
  with the one the secret-binding check read before any credential is written; a secret written
  before the conditional update finds the row moved is withdrawn, audited as `vault.delete`
  (reason `concurrent_update`). An update that has already landed keeps its new secrets.
- A replaced credential is no longer retired while a pending, running, failed or cancelled
  scheduled task still names it in its payload, so retrying that task can still read the secret.
- Not yet covered: secrets created before some other step fails, and bounding how long Tasks hold
  secret references (#574).
