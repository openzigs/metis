---
issue: 574
section: Security
---

- A Jira, test-management or MCP server create or update that fails part-way — a later vault
  write (the TLS CA certificate after the API token, the second Xray credential) or the row write
  itself — no longer leaves the secrets it had already written in the vault. They are withdrawn
  and audited as `vault.delete`. An MCP server create refused after auto-vaulting a plaintext env
  or header value (label taken, image denied, quota reached) withdraws those values too.
- A failed or cancelled task can now be retried for 7 days after it ended; after that,
  `POST /api/tasks/:id/retry` answers 409 `TASK_RETRY_EXPIRED` and a new task must be enqueued.
  Past that window the task's payload no longer keeps a replaced webhook credential alive, so an
  old failed webhook task no longer pins a secret for ever.
