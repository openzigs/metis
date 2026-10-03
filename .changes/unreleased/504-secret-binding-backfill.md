---
issue: 504
section: Security
---

- MCP servers and live publish batches saved before #480 are bound to their vault secret at server
  start. A reference that is ambiguous, missing, or to a secret the owner (an MCP server's creator)
  did not create (#344; `vault.reveal` holders and `api.github.com` batches exempt) is flagged
  (`vault.binding_backfill_flagged`), not bound: re-save the server; the batch cannot publish.
  One row's unexpected error is logged and skipped, never stopping the rest.
- MCP header vault references (such as an imported `Authorization` header) are expanded at connect
  through the server's bindings only, never by label: an unbound server with one will not start.
