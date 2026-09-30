---
name: time-dependent-refs-need-recheck
description: Vault retirement is one-shot; a time-bounded reference rule leaves secrets kept during the window live for ever. Test fakes can lack new interface methods.
metadata:
  type: project
---

- `retireReplacedSecret` runs once, when a secret is replaced. #574 made `isSecretReferenced` depend on a 7-day Task retry window, so a secret kept while a Task was in-window is never re-checked (#591).
- `server/tsconfig.json` excludes `tests/`, so a fake typed as an interface (e.g. `RevocationStore` in #596) silently lacks newly added methods; typecheck green is no evidence.

**Why:** both look correct at the moment of review and decay later.

**How to apply:** whenever a reference or retention rule depends on time, ask for a periodic re-check and a test of the aged-out case; when widening an interface, grep `tests/` for its fakes and add the method.
