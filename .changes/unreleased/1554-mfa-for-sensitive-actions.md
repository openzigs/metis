---
issue: 1554
section: Security
---

- A SAML or OIDC sign-in without MFA can no longer change admin or SSO
  settings, reveal or rotate a vault secret, or change a user's or workspace
  role; the message names the fix (require MFA for METIS in Conditional
  Access). Password sign-ins (LDAP, local break-glass) are not asked for MFA.
- Passwordless Entra sign-ins count as MFA, including synced passkeys.
- An Entra OIDC app must add the optional `amr` ID-token claim, and an SSO
  session from before MFA was recorded must sign in again for these actions.
