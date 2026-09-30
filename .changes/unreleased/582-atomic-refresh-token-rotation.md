---
issue: 582
section: Security
---

- Refresh-token rotation is single-use under concurrency: revocation is one
  atomic insert-if-absent on the token id, so of two concurrent refreshes with
  one token only one gets new tokens. A SCIM deprovision that lands during a
  refresh also refuses the new pair.
- The UI's page and in-app refreshes share one single-flight per refresh token,
  so parallel requests or several tabs no longer log each other out.
- A transient database error during the refresh's cutoff re-check returns a
  retryable 503 and leaves the token usable, instead of forcing a new login.
