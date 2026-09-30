---
issue: 482
section: Security
---

- Rotating a vault secret that another user created now asks for confirmation.
  The Vault page names the owner and the DB and repo connectors, import sources,
  Jira connections and MCP servers (via `${vault:...}` references in their env or
  headers) that use it, and rotates only after **Rotate anyway**. Before, an admin
  could rotate a real value into a coordinator's secret and the coordinator's
  connector would send it to a host they chose. The API returns
  `409 VAULT_ROTATE_FOREIGN_OWNER` unless `confirmForeignOwner: true` is set, and
  the audit entry records the confirmation. Your own and system secrets are unchanged.
