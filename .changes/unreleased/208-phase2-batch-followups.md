---
issue: 208
section: Fixed
---

- A cut-off section batch's warning no longer depends on the order batches
  finish in. An `openai` provider on a loopback or private base URL defaults
  to one Phase-2 call at a time, and with prompt caching the first batch's
  reply begins before the other batches are sent.
