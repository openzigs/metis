---
issue: 489
section: Fixed
---

- A generated document whose publication was cancelled now shows a
  "cancelled" indexing badge, in a neutral tone, beside its cancelled message.
  The badge used to read "failed" (or "pending", once the document's indexing
  record existed). The API reports `indexing.state` and `indexing.status` as
  `cancelled` for such a publication.
