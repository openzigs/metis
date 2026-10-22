---
issue: 1395
section: Security
---

- Accounts are keyed on the sign-in identity (OIDC `iss`+`sub`, SAML Issuer+NameID, the
  LDAP account name), not the username: an OIDC or SAML user named like an LDAP user, or
  like another SSO provider's user, is refused with `409 ACCOUNT_LINK_REQUIRED` instead of
  signing in as that account. Existing accounts get their provider from the audit log; a
  host operator links a second identity with `link-identity-cli.ts`.
