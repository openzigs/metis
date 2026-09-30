---
issue: 482
section: Security
---

- Rotating a vault secret that another user created now asks for confirmation.
  The Vault page shows who owns the secret and which connectors, MCP servers and
  Jira connections it is bound to, and rotates it only after you choose
  **Rotate anyway**. Before, an admin could rotate a real value into a
  coordinator's secret without warning, and the coordinator's connector would
  then send that value to the host the coordinator chose. The API returns
  `409 VAULT_ROTATE_FOREIGN_OWNER` with the owner and bindings unless the request
  sets `confirmForeignOwner: true`. The audit entry for a confirmed rotation
  records the confirmation and the owner. Rotating your own secret, or a secret
  the system wrote, works as before.
