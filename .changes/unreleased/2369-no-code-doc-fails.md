---
issue: 2369
section: Fixed
---

- A Business Requirements, Architecture or User Guide document for the full project or a
  repository, on a project with no indexed source code (only uploaded documents, say), no longer
  reports "Documentation ready" over a stub that says it could not be generated, and that stub is
  no longer added to the project's knowledge awaiting review. The document is marked failed, the
  error toast says why and what to do, and the Generate form warns before you start that the
  document type needs connected source code.
