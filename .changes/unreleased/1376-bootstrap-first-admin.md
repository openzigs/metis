---
issue: 1376
section: Added
---

- `METIS_BOOTSTRAP_ADMINS` gets the first admin on an LDAP, OIDC or SAML install: a listed
  username or e-mail that signs in while no user holds the admin role is granted admin. It has
  no effect once an admin exists, and on OIDC only an IdP-verified e-mail matches.
- OIDC and SAML providers can be configured from `AUTH_OIDC_*` / `AUTH_SAML_*` at boot, on every
  replica, so an SSO-only install can sign in (and bootstrap its admin) without the admin API,
  whose provider settings are kept in memory only.
