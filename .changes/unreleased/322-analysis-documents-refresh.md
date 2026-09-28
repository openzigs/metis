---
issue: 322
section: Fixed
---

- A document added from the Analysis page's "Add documents" panel becomes
  selectable as soon as its ingest finishes. The page read the documents list
  once after the upload, usually while the document was still `pending`, and
  never read it again, so its checkbox stayed disabled until a reload.
