---
issue: 358
section: Security
---

- Behaviour change: without `vault.reveal`, listing Projects v2 boards or a live publish to a
  `targetBaseUrl` other than `api.github.com` may use only a vault secret the caller created (403
  `SECRET_BINDING_FORBIDDEN`); batch `metadata` can no longer override the batch's `secretRef`.
- Jira and test-management credentials are owned by whoever typed them. A non-admin who changes a
  connection's base URL or proxy, or turns TLS verification off, must re-enter credentials they did
  not supply; updating another user's credentials creates a new secret instead of overwriting.
- A `${vault:label}` reference matching more than one secret (e.g. `global:x` and `project:x`) is
  refused with 409 `VAULT_REF_AMBIGUOUS` instead of resolving to the newest; qualify it.
