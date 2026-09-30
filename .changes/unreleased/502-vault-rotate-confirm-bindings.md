---
issue: 502
section: Security
---

- "Rotate anyway" on another user's vault secret is now tied to the bindings you
  were shown. If the owner re-pointed, added or removed a binding in between, the
  rotation is refused and the Vault page shows the current list to confirm again.
  A confirmed rotation makes you the secret's owner, so the previous owner can no
  longer bind it, now holding your value, to a new destination; their existing
  bindings keep working where they are. API clients must send
  `confirmedBindingIds` with `confirmForeignOwner: true` (a mismatch returns
  `409 VAULT_ROTATE_BINDINGS_CHANGED`), and the `vault.rotate` audit entry
  records the confirmed binding ids.
