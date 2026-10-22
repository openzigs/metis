---
name: sso-login-identity-matching
description: Traps in SSO/LDAP/SCIM login identity matching and local OIDC testing (#1393, #1400 for #1395).
metadata:
  type: project
---

**Why:** found building SSO cookies and bootstrap admins (PR #1393) and matching sign-ins by
provider identity (#1395, PR #1400) and in their reviews.

**How to apply:**

**Identity matching.**
- SAML/OIDC users get a username derived from the e-mail local part when no
  `upn`/`uid`/`preferred_username` is sent. Allowlists, bootstrap admins and role mappings
  must not trust that derived username.
- SCIM-provisioned rows need a provider marker (`authSource='scim'`). Otherwise a gate keyed
  on a NULL `authSource` also refuses every SCIM user under SAML, which has no
  `email_verified`.
- A case-folded LDAP identity needs a case-insensitive legacy username lookup too, or a
  first login in a different case binds a new, empty account.
- A login-path write that binds or modifies a `users` row before `reconcileTrustedLoginRole`
  leaves side effects on disabled or soft-deleted users (`status`/`deletedAt` are checked
  only later). Filter `deletedAt: null` and `status: active` on every login-path write;
  SCIM's revive upsert inherits a deleted row's identities.

**Configuration.** SSO providers set through the admin API live only in an in-memory Map
(`server/src/lib/auth/sso-config.ts`). Production must use `AUTH_OIDC_*` / `AUTH_SAML_*`,
which every replica seeds at boot.

**Local OIDC testing.**
- openid-client v6 refuses every `http://` request (`OAUTH_HTTP_REQUEST_FORBIDDEN`). Local
  OIDC (Keycloak on :4600, the mock IdP) works only through `allowsPlainHttpIdp` in
  `oidc-provider.ts`: loopback only, never production.
- `startMockOidcIdp()` (`scripts/lib/mock-oidc-idp.mjs`) binds a new port, so each call is a
  new issuer. Since #1395 the same `preferred_username` from two issuers is refused: reuse one
  instance and call `setUser()`.

Related: [[client-address-behind-the-ui-proxy]], [[prisma-cross-database]].
