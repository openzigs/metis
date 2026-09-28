---
issue: 324
section: Security
---

- Behaviour change: revealing a vault secret's plaintext now needs the new `vault.reveal`
  permission, which only administrators hold. Coordinators and developers keep `vault.read`:
  they still list the vault and use secrets by reference (chat keys, connectors, MCP), but
  `GET /api/vault/:id/reveal` answers 403 and the Reveal button is hidden for them.
- Behaviour change: every reveal attempt is audited as `vault.reveal` with an `outcome` of
  `granted`, `denied` or `not_found` (previously a successful reveal was logged as `vault.read`).
  The suggested-connector wizard withholds a stored password from non-administrators, who
  provision with it by leaving the password blank.
