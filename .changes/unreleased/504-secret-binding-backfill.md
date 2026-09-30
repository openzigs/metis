---
issue: 504
section: Security
---

- MCP servers and live publish batches saved before #480 are now bound to their vault secret at
  server start. An ambiguous or missing reference is flagged (`vault.binding_backfill_flagged`),
  not guessed: the MCP server will not start until re-saved, and the batch cannot publish.
- Test-management connections read their stored secret by id only; a secret later created with a
  label equal to that id is never picked up (409 `VAULT_BINDING_STALE` — re-enter the credential).
- MCP header values that reference a vault secret, such as an imported `Authorization` header, are
  now expanded when the server connects instead of being sent literally.
