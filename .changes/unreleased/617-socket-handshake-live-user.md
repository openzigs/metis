---
issue: 617
section: Security
---

- Opening a real-time connection now checks that the user is still active and
  not deleted, the same as every API request, and takes the user's role from
  their current role assignments rather than from the access token. A user
  deprovisioned over SCIM (or disabled, or deleted) can no longer reconnect with
  an access token that has not yet expired. A user whose role was lowered can no
  longer join admin-only live updates on the old role until the token expires.
  If the user cannot be looked up, the connection is refused.
