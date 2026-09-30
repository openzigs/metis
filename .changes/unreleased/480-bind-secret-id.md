---
issue: 480
section: Security
---

- A vault reference is now bound to the secret it resolved to when the DB connector, repo
  connector, MCP server or publish batch was saved. If that secret is deleted, the resource refuses
  to use it (409 `VAULT_BINDING_STALE`; an MCP server fails to start) instead of picking up another
  secret created later under the same label. To use a different secret, select it again.
- Behaviour change: saving a DB connector, MCP server or live publish batch whose `${vault:...}`
  reference names no live secret is refused up front (400 `VAULT_REF_UNRESOLVED`, or 409
  `VAULT_REF_AMBIGUOUS` for a label in both scopes) rather than failing when the resource is first
  used. DB connectors can now be saved with a secret label as well as an id.
- MCP servers saved before this release keep resolving by label until their env or headers are next
  saved.
