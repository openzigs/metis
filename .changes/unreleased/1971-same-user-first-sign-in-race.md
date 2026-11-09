---
issue: 1971
section: Fixed
---

- Signing in for the first time in two tabs at once (or submitting an SSO sign-in twice) no
  longer fails one of them with a server error. The second sign-in now picks up the role the
  first one granted, and a role an administrator or SCIM assigned at the same moment is still
  kept rather than replaced.
