---
issue: 2321
section: Fixed
---

- With the document reader on (`ANALYSIS_DOCUMENT_READER`) and no document selected, a project
  with no uploaded document and one whose every upload you may not see now give the same result:
  "No document was read", and the document agent does not search the project's content instead.
  Before, the document agent's result told you that restricted documents existed. The code
  agent's search in the same analysis still reads restricted uploads; that is tracked in #2431.
- With no document selected, the document agent's summary now counts the documents it found as
  "uploaded", not "selected" (for example "Read 0 of 1 uploaded document").
- The audit log entry for documents withheld from an analysis with no document selected now
  names only the restricted documents it would have read, not every restricted upload in the
  project.
