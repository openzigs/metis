---
issue: 1564
section: Security
---

- The MFA requirement for admin settings now follows the permission, not the URL: changing a
  project's token budget, creating, editing or deleting a scheduler trigger, adding a local server
  path connector, and starting an eval leaderboard or red-team run need an MFA sign-in, as does
  removing a workspace member. An OIDC sign-in whose `amr` claim names a single factor, such as a
  lone `otp` or `hwk`, no longer counts as MFA. A password (mock or LDAP) sign-in is no longer
  asked for MFA after a refresh because the account also signs in through SSO. The UI's MFA
  message no longer names Microsoft Entra.
