---
issue: 1117
section: Security
---

- An access token that expired more than 15 minutes ago no longer selects its
  user's rate-limit bucket, so an old token cannot be used to
  have that user refused with 429.
- A browser with no valid session is told `401` by `/api/runs`, discussion
  message edits and deletes, and source-divergence answers even when the shared
  anonymous bucket is spent, so it refreshes or signs in instead of seeing a
  rate-limit error.
