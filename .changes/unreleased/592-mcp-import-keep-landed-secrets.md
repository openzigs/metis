---
issue: 592
section: Security
---

- An mcp.json import entry that fails after its server row is saved no longer deletes the vault
  secrets that row points to. Secrets from an entry whose row was never saved are still withdrawn,
  and each withdrawal is now recorded in the audit log as `vault.delete`.
- A project-scoped MCP server create that is refused after auto-vaulting now records the project on
  the audited withdrawal of its secrets.
