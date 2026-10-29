---
issue: 1552
section: Security
---

- Microsoft Entra ID SAML: group object IDs and app roles now map to METIS roles
  (they were ignored, so every Entra user got the default role); a group overage
  is logged and shown to admins in the audit log; a password-only sign-in no
  longer counts as MFA, and the MFA result now stays with the session; an
  unsigned Response names Entra's "Sign SAML response and assertion" setting.
