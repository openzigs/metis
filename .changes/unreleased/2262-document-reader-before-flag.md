---
issue: 2262
section: Fixed
---

- With the document reader on (`ANALYSIS_DOCUMENT_READER`), Requirements Analysis reads only documents the person who started it may see: a document restricted to someone else is listed as not available, and the analysis never falls back to searching it instead.
- The reader now receives the operator's analysis notes, as every other analysis agent does.
- With no document selected, the reader reads the five most recently uploaded documents and lists the rest in "Documents read in full" with how to have them read. A document over about 80 KB is read section by section, and the document is cached across the reader's calls, so cost no longer grows with the square of a document's length. Impact Analysis's document reading uses the same bound and caching.
- A statement whose quoted passage lies outside the sections the model was asked about is no longer attributed to the wrong section; it is left out and counted.
- Tokens a document reading spent before it failed now count toward the monthly analysis budget.
