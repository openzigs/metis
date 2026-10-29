---
issue: 1559
section: Added
---

- `make entra-up` (or `pnpm saml:entra`) runs the Microsoft Entra ID-profile mock
  SAML IdP next to a dev server and seeds METIS's SAML provider from its
  Federation Metadata, so an Entra sign-in can be clicked through by hand. Its
  account picker offers an MFA admin, a password-only member and a group-overage
  user, and switches the signing option to reproduce Entra's default refusal.
  `make entra-down` stops it.
