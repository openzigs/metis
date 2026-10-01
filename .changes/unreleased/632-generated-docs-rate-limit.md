---
issue: 632
section: Security
---

- The generated-documentation API (`/api/projects/:projectId/docs`) is now rate-limited as a
  whole, not only its generate action. Each signed-in user gets 900 requests per 15 minutes
  (`GENERATED_DOCS_RATE_LIMIT_MAX`), and each IP address gets 3,600 before sign-in is checked
  (`GENERATED_DOCS_PREAUTH_RATE_LIMIT_MAX`). Both are well above what the Documentation page's
  polling needs. A caller over the limit gets `429` with the code `GENERATED_DOCS_RATE_LIMITED`.
