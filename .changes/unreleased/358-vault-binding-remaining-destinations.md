---
issue: 358
section: Security
---

- Behaviour change: without `vault.reveal`, listing Projects v2 boards or running a live publish
  against a `targetBaseUrl` other than `api.github.com` may use only a vault secret the caller
  created (403 `SECRET_BINDING_FORBIDDEN`, audited `vault.binding_refused`).
- Jira and test-management credentials are now owned by whoever typed them. A non-admin who
  changes a connection's base URL, proxy or TLS verification must re-enter its credentials unless
  they supplied them; updating another user's credentials creates a new secret instead of
  overwriting theirs.
- A `${vault:label}` reference that matches more than one secret (for example `global:x` and
  `project:x`) is now refused with 409 `VAULT_REF_AMBIGUOUS` instead of resolving to the newest.
  Qualify the label or use the secret id.
