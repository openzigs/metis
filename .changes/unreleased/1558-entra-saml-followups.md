---
issue: 1558
section: Fixed
---

- The SAML 2.0 tab's group-overage warning now covers the last 30 days only, so it
  clears once the Entra group claim is fixed, and names the role each user got: an
  app-role mapping can still match a user whose groups overflowed.
- The warning's audit read uses a new `audit_logs` (`action`, `ts`) index
  instead of scanning the table.
