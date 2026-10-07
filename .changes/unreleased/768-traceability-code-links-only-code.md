---
issue: 768
section: Fixed
---

- Requirement-to-code traceability no longer stores retrieval documents as
  direct code links. A man page, an uploaded doc, the live database schema or a
  `connector:db:` doc used to count as code and inflate workspace code
  coverage. Only citations that resolve to the project's code graph are linked,
  under the repository path and, for a code citation, the symbol and its lines.
