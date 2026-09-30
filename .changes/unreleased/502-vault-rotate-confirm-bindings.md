---
issue: 502
section: Security
---

- "Rotate anyway" on another user's vault secret is now tied to the bindings you
  were shown, destinations included. If the owner re-pointed a binding at a new
  host, added one or removed one in between, the rotation is refused and the
  Vault page shows the current list to confirm again.
  A confirmed rotation makes you the secret's owner, so the previous owner can no
  longer bind it, now holding your value, to a new destination; their existing
  bindings keep working where they are. API clients must send
  `confirmedBindings` (the `type`, `id` and `destination` of every binding
  listed) with `confirmForeignOwner: true` (a mismatch returns
  `409 VAULT_ROTATE_BINDINGS_CHANGED`), and the `vault.rotate` audit entry
  records the confirmed bindings with their destinations.
