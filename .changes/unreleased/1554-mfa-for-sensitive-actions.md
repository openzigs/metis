---
issue: 1554
section: Security
---

- Security-sensitive actions now require a sign-in with MFA when you sign in
  through SAML or OIDC: changing admin and SSO settings, revealing or rotating a
  vault secret, and changing a user's role or workspace role (including workspace
  invites and ownership transfer). A session without MFA gets a clear message
  saying the action needs an MFA sign-in and that the fix is for the Entra
  administrator to require MFA for METIS in Conditional Access. Reading, analysis,
  chat, review and publishing are unchanged.
- Passwordless Entra sign-ins count as MFA, including synced passkeys, which
  Entra reports as `SoftwarePKI` and METIS previously read as not MFA.
- Password sign-ins (mock, LDAP/AD), including a local break-glass admin, are not
  asked for MFA. An SSO session started before METIS recorded the MFA result must
  sign in again before a gated action.
- An Entra OIDC app must add the optional `amr` claim to its ID token; without it
  a sign-in counts as not MFA.
