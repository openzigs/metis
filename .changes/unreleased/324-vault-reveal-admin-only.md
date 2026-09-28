---
issue: 324
section: Security
---

- Behaviour change: revealing a vault secret's plaintext needs the new admin-only `vault.reveal`
  permission; other roles keep `vault.read` and use secrets by reference, but reveal answers 403.
- Behaviour change: every reveal attempt is audited as `vault.reveal` (previously `vault.read`;
  update audit filters) with an `outcome`, never the value; reveal is rate-limited per client IP
  ahead of auth (`VAULT_REVEAL_LIMIT_MAX`, default 30; `VAULT_REVEAL_RATE_LIMIT_WINDOW_MS`, 60000).
- Behaviour change: no HTTP response returns a stored suggestion password to a non-administrator;
  the suggested-connector test and provision routes refuse it for another driver, host or port
  (403 `STORED_SECRET_DESTINATION_MISMATCH`). Not yet bound after provisioning or via options.
