---
issue: 611
section: Security
---

- An admin can now take over another user's vault secret that has more than
  1,000 bindings. Before, "Rotate anyway" was rejected, so an owner could add
  bindings to block a takeover. The Vault page says when the list is too long to
  confirm one by one, still shows every binding, and confirms the whole list as
  one. API clients may send `confirmedBindingsDigest` (the 409's
  `bindingsDigest`) instead of `confirmedBindings`; a stale digest returns
  `409 VAULT_ROTATE_BINDINGS_CHANGED`.
