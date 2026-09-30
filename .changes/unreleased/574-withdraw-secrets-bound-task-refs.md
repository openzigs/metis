---
issue: 574
section: Security
---

- A Jira, test-management or MCP server create or update that fails part-way — a later vault
  write (the TLS CA certificate after the API token, the second Xray credential) or the row write
  itself — no longer leaves the secrets it had already written in the vault. They are withdrawn
  and audited as `vault.delete`. An MCP server create refused after auto-vaulting a plaintext env
  or header value (label taken, image denied, quota reached) withdraws those values too.
- A failed or cancelled task can be retried for 7 days after it ended; after that,
  `POST /api/tasks/:id/retry` answers 409 `TASK_RETRY_EXPIRED`. A webhook credential replaced
  after a task's window has passed is no longer pinned by it; one replaced while the window is
  still open is kept and not re-checked later (periodic re-check: follow-up #591).
