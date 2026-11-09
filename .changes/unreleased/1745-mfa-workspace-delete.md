---
issue: 1745
section: Security
---

- Deleting a workspace now needs a sign-in with multi-factor authentication (MFA), like the
  other role changes, because it removes every member's access. An SSO session that did not use
  MFA gets `403 MFA_REQUIRED`. A workspace administrator's own settings (name, logo, budget,
  integrations and governing documents) are still not gated, and the Azure AD guide now says why.
- Removing a member, changing a member's role, deleting a workspace, and enabling, disabling or
  deleting a trigger now show why the action was refused. Before, an MFA refusal showed nothing.
