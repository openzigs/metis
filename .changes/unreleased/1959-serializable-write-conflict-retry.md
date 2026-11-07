---
issue: 1959
section: Fixed
---

- Signing in while many other people sign in at once no longer fails with a server error, or
  with a false "username or e-mail address already belongs to another METIS account" refusal.
  A sign-in that collides with others is retried; one that still cannot complete is answered
  `503 SIGN_IN_CONFLICT` (try again) and is no longer audited as an identity conflict. SCIM
  provisioning and administrator role reconciliation retry the same collisions instead of
  failing.
