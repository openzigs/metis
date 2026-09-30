---
issue: 552
section: Security
---

- "Rotate anyway" on another user's vault secret can no longer race the owner
  binding that secret somewhere new. Every binding write (connectors, publishing,
  MCP create, edit, re-bind and import) now marks the secret before its ownership
  check. A confirmed rotation is refused with `409 VAULT_ROTATE_BINDINGS_CHANGED`
  when such a write has landed since the bindings were listed, or with
  `409 VAULT_ROTATE_BINDING_IN_PROGRESS` while one may still land.
- A binding write that takes longer than the one-minute mark to save is refused
  with `409 SECRET_BINDING_WINDOW_EXPIRED`. In an mcp.json import, only the late
  entry fails. Marking a secret does not change its "Updated" time.
