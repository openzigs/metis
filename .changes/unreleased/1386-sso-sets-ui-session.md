---
issue: 1386
section: Fixed
---

- An OIDC or SAML login now ends signed in: the callback sets the UI's `metis.at` / `metis.rt`
  session cookies (`Secure` in production) instead of cookies nothing read, and redirects to
  `APP_URL`, else the `CORS_ORIGIN` UI origin, instead of `http://localhost:3000`. A loopback
  `http://` IdP is accepted outside production, so the local Keycloak harness and an in-process
  test IdP can complete a login.
