---
issue: 2530
section: Fixed
---

- With the document reader on (`ANALYSIS_DOCUMENT_READER`), an analysis of a long document no
  longer loses its structured requirements and approval checkpoints because one reply could not
  hold them all. The requirements are now extracted from the reader's statements 20 at a time,
  four batches at once, and joined in document order. On the four-document test corpus the
  extraction failed on every document on Sonnet 5.5 and now completes on all four. Clarifying
  questions on these documents still fail on their own output cap (#2534).
