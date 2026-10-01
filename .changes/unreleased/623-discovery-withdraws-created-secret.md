---
issue: 623
section: Security
---

- Repo credential discovery now withdraws a password secret it created (because the
  suggestion's old secret was missing or deleted) when the suggestion write then fails, audited
  as `vault.delete` with `source: create_not_applied` (or `update_not_applied` for an existing
  suggestion). A suggestion that landed keeps its new secret, so no orphaned system-owned secret
  is left behind.
