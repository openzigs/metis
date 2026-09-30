---
issue: 557
section: Security
---

- Confirming a rotation of another user's vault secret now also covers what the listed
  destination does not show. The refusal gives each binding a `routing` digest over every
  field that decides where the secret goes, and the confirm must send it back. If the owner
  changes the args of the same MCP command, or the database on the same DB host, the confirm
  is refused with `VAULT_ROTATE_BINDINGS_CHANGED` and the admin sees the list again.
