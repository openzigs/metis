---
issue: 1395
section: Security
---

- Accounts are keyed on the sign-in identity (OIDC `iss`+`sub`, SAML Issuer+NameID, the
  LDAP entryUUID/objectGUID or folded account name), not the username: a user named like
  another provider's user is refused with `409 ACCOUNT_LINK_REQUIRED`. An SSO sign-in
  claims an existing unbound account only on a verified matching e-mail; disabled or
  deleted accounts are refused. A host operator links identities with `link-identity-cli.ts`.
