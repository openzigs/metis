---
issue: 324
section: Security
---

- Behaviour change: revealing a vault secret's plaintext needs the new admin-only `vault.reveal`
  permission; other roles keep `vault.read` and use secrets by reference, but reveal answers 403.
- Behaviour change: every reveal attempt is audited as `vault.reveal` with an `outcome`
  (`granted`, `denied`, `not_found`), never the value; the route is rate-limited per client IP
  (`VAULT_REVEAL_LIMIT_MAX`, 30/min) ahead of auth, so set `TRUST_PROXY` correctly behind a proxy.
- Behaviour change: the suggested-connector wizard withholds a stored password from
  non-administrators, who may use it only against the suggestion's own driver, host and port
  (otherwise 403 `STORED_SECRET_DESTINATION_MISMATCH`); a blank password reuses the stored one.
