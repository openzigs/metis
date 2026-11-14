---
issue: 2321
section: Fixed
---

- With the document reader on (`ANALYSIS_DOCUMENT_READER`) and no document selected, a project
  with no uploaded document and one whose every upload you may not see now give the same result:
  "No document was read", and the analysis does not search the project's content instead. Before,
  the difference told you that restricted documents existed.
- The audit log entry for documents withheld from an analysis with no document selected now
  names only the restricted documents it would have read, not every restricted upload in the
  project.
