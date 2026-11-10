---
issue: 1562
section: Security
---

- **SAML upgrade note:** since the assertion Issuer check (#1555), a stored IdP issuer
  that is not exactly the Issuer your IdP asserts refuses every SAML sign-in; compare
  them before upgrading (`docs/auth/saml.md`). **Admin → Authentication → SAML 2.0**
  now shows the configured issuer beside the last refused one.
- `make saml-up` seeds the real SP endpoints (`/api/auth/saml/...`), and the mock Entra
  IdP's account picker accepts only a form it rendered.
