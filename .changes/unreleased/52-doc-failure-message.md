---
issue: 52
section: Security
---

- A failed documentation generation no longer returns the server's raw
  exception text from `GET /projects/:id/docs/:docId` (or `PATCH`). The document
  now carries a fixed, user-facing reason: the restart message, a provider's
  "402 Insufficient Balance", the project's token budget, a rate limit, rejected
  provider credentials, or a generic failure. Documents that failed before this
  release are sanitised when read. The full error, with its stack, is written to
  the server log — where, until now, it had been logged as an empty object.
