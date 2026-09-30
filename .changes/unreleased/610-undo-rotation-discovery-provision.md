---
issue: 610
section: Security
---

- Repo credential discovery and suggested-connector provisioning now restore a password they
  rotated in place when the suggestion or connector write then fails, audited as `vault.rotate`
  with `source: update_not_applied`. A write that landed keeps the new password.
