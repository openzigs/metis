---
issue: 2230
section: Added
---

- Requirements Analysis can read each selected document in full instead of ten retrieved chunks (`ANALYSIS_DOCUMENT_READER`, off by default). The model reads the whole document, labels every statement as a requirement, constraint, business rule, assumption, definition, background or example, and cites each one to the passage it rests on; a statement whose quoted passage is not in the document is left out and counted.
- With the reader on, the analysis results page shows "Documents read in full": every selected document and section, what was found in each, a section that produced nothing, and anything that could not be read, with the reason.
- `pnpm --filter server eval:doc-understanding --arms R` measures the reader against the #2229 corpus.
