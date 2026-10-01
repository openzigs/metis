---
issue: 609
section: Security
---

- Rotating another user's vault secret now lists the test-management connections (Xray,
  Zephyr, TestRail) whose auth or TLS config references it, alongside the other bindings the
  admin must confirm. Their `routing` digest covers the kind, base URL, proxy and TLS config,
  so routing one through a new proxy under the same base URL refuses the confirm with
  `VAULT_ROTATE_BINDINGS_CHANGED`. API clients see a new binding `type`,
  `test_management_connection`.
