---
issue: 2429
section: Fixed
---

- Answering a clarifying question about a requirement that already exists now counts as an edit of it. The analysis findings it was written from are marked stale in the findings list and the traceability matrix, because the analysis judged the wording before the answer. Answers written in when the requirements are first created still mark nothing.
- The governing results that METIS re-checks after an answer are current for the answered requirement once they are stored. If the re-check fails, the earlier results stay marked stale after the run ends, with **Re-check this requirement** offered, instead of reading as current.
- Editing one paragraph of a document no longer reopens the answer to a near-identical paragraph beside it. An answer whose paragraph the document still holds word for word stays settled.
