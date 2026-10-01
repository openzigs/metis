---
issue: 629
section: Security
---

- Refusing a takeover of another user's vault secret no longer grows with the
  owner's binding count. Over 1,000 bindings the `409` lists the first 1,000
  plus `bindingsTotal`, `bindingsTruncated` and `bindingCounts` (per type and
  per destination host) for the whole set, its message names at most ten
  bindings, and the `vault.rotate` audit row records the bindings digest, total
  and counts instead of every binding. The Vault page shows the counts over
  the whole set and says when the list is cut short.
