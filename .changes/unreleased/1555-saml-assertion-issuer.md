---
issue: 1555
section: Security
---

- SAML sign-in now refuses an assertion whose `Issuer` is not the configured IdP
  issuer (or that has none), with a message naming both values. A Response signed
  by the trusted certificate for another issuer, such as another Microsoft Entra
  tenant, no longer signs in.
