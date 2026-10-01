---
issue: 629
section: Security
---

- Refusing a takeover of another user's vault secret no longer grows with the
  owner's binding count: over 1,000 bindings the `409` lists the first 1,000
  plus `bindingsTotal`, `bindingsTruncated` and `bindingCounts` for the whole
  set, names at most ten, and the `vault.rotate` audit row records the digest,
  total and counts. The Vault page shows those counts.
- A `confirmedBindings` list for a set over 1,000 is refused with
  `409 VAULT_ROTATE_CONFIRM_BY_DIGEST` (capped details and `bindingsDigest`),
  not a `VAULT_ROTATE_BINDINGS_CHANGED` a client would resend forever.
