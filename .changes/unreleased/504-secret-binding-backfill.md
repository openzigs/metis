---
issue: 504
section: Security
---

- MCP servers and live publish batches saved before #480 are bound to their vault secret at server
  start. A reference that is ambiguous, missing, or to a secret the owner did not create (#344;
  `vault.reveal` holders exempt) is flagged (`vault.binding_backfill_flagged`), not bound: the
  server will not start until re-saved, and the batch cannot publish or close issues.
- Test-management connections read their stored secret by id only (409 `VAULT_BINDING_STALE` when
  it is gone — re-enter the credential); other vault failures surface unchanged.
- MCP header values that reference a vault secret, such as an imported `Authorization` header, are
  expanded when the server connects instead of being sent literally; a failure names the header.
