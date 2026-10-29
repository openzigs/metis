---
issue: 1553
section: Added
---

- An in-process Microsoft Entra ID-profile SAML IdP for tests: Entra's claims,
  signing options, MFA, group overage and signed Federation Metadata. CI signs in
  through it from the login page's SAML button, with no external network.
  `docs/auth/saml-local-testing.md` documents it, plus a real-tenant smoke test.
