---
issue: 2205
section: Fixed
---

- **Admin → Authentication → SAML 2.0**: the group-overage warning names each user once,
  with the role of their newest such sign-in, and says how that role was chosen. A role
  granted in METIS or by SCIM wins over the IdP's mappings, so the warning no longer says
  every user got an app-role mapping's role or the default role.
- The mock Entra IdP's `expired: "conditions"` profile emits a Conditions window that
  starts before it ends.
