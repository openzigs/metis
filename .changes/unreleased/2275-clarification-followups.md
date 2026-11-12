---
issue: 2275
section: Fixed
---

- The newer clarifying-question handling now applies only when the document reader (`ANALYSIS_DOCUMENT_READER`) is on. This covers the question kinds, the questions set aside as not worth asking, the limit of 8 questions a round, and searching only for missing knowledge. With the reader off, every question raised is asked and checked against your project's documents, as before.
- A question no longer says METIS "searched your documents and code" when no search ran.
- A finished set of questions no longer says more questions are "waiting for the next round".
- Approval cards and the questions panel now count the questions set aside as not worth asking as addressed, as the server already did, so those questions no longer show as open.
- Vague terms, escape clauses and "TBD" placeholders are now found in every statement the document reader reads, not only the statements a requirement cites.
- A document's filename, section headings and the reader's statements are now passed to the model as data it must not take instructions from, like the quoted text.
