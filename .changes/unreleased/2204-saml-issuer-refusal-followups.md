---
issue: 2204
section: Fixed
---

- **Admin → Authentication → SAML 2.0**: the refused-Issuer warning now clears as soon
  as you save metadata naming the Issuer the IdP asserts, without reloading the page.
  Switching back to an issuer that was refused earlier shows that refusal again, rather
  than nothing, and the lookup reads only the SAML provider's own refusals instead of
  scanning the audit log.
- `make entra-down` and `make entra-up` treat a pid as the mock Entra IdP only when it
  is a node process running `entra-idp.mjs`, not any command line that mentions it.
