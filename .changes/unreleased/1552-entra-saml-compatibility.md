---
issue: 1552
section: Security
---

- Microsoft Entra ID SAML sign-ins now map to the METIS role configured for the
  user's group: METIS reads Entra's group claim (group object IDs) and app-role
  claim, which it previously ignored, so every Entra user got the default role.
- A password-only SAML sign-in is no longer counted as multi-factor.
  `PasswordProtectedTransport` (a password over TLS) and `X509` (single-factor
  certificate) no longer count; Entra's `multipleauthn` authentication method
  and its `MobileTwoFactorContract` / `SmartcardPKI` classes do. The MFA result
  now travels with the session, including across a token refresh.
- When Entra sends a user's groups as an overage link (more than 150 groups),
  the user signs in with the default role and admins see an
  `sso.saml.group_overage` event in the audit log, instead of nothing.
- A SAML Response whose envelope is not signed is refused with a message that
  names Entra's "Sign SAML response and assertion" setting.
- Entra's Federation Metadata XML is read for its token-signing certificate
  from the SAML section only, not from the metadata's own signature.
