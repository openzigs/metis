---
issue: 502
section: Security
---

- "Rotate anyway" on another user's vault secret is now tied to the bindings you
  were shown, destinations included: if the owner re-pointed, added or removed a
  binding in between, the rotation is refused and the Vault page shows the
  current list to confirm again. A confirmed rotation makes you the secret's
  owner, so the previous owner can no longer bind it to a new destination. API
  clients must send `confirmedBindings` (`type`, `id`, `destination` of each
  binding listed) with `confirmForeignOwner: true`; a mismatch returns
  `409 VAULT_ROTATE_BINDINGS_CHANGED`. The `vault.rotate` audit entry records
  the confirmed bindings with their destinations.
