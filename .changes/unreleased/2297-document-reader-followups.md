---
issue: 2297
section: Fixed
---

- With the document reader on (`ANALYSIS_DOCUMENT_READER`), regenerating the document agent now counts the tokens a failed or cancelled document reading spent toward the analysis's total and the monthly analysis budget.
- A selected document you may not see and one that does not exist or is not ready now look the same in an analysis: both are listed as not available, and neither makes the analysis search instead. Each time the reader withholds a document from someone, and each time an admin reads a restricted document only because they are an admin, an audit log entry is written.
- A short document read in one pass no longer pays for a prompt cache entry nothing reads back.
- With no document selected, documents beyond the five most recent are described as left out, not as documents that "could not be read".
- A scheduled analysis no longer fails its document step with the reader on: it reads the project's unrestricted documents.
