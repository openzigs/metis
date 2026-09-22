---
issue: 69
section: Fixed
---

- The project Documents page no longer treats a quarantined document as still
  ingesting. One kept `status = processing`, so the page polled the document
  list every 3 seconds for as long as it existed and listed it as
  "processing". Quarantined rows now read "awaiting review" and link to the
  quarantine queue, and the poll stops when nothing is genuinely ingesting.
