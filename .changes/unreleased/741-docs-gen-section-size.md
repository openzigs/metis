---
issue: 741
section: Changed
---

- Generated documents are bounded in length: about 60,000 characters per section
  (`DOCS_GEN_SECTION_MAX_CHARS`) and 250,000 per document (`DOCS_GEN_DOCUMENT_MAX_CHARS`).
  Catalogue sections such as Business Rules are written as business-level rules within a
  per-batch word budget, in fewer model calls. Anything still over the cap is shortened at
  topic boundaries, never mid-sentence, with a note naming the topics left out.
- The section cap is now part of each section's reuse hash, so the first regenerate (or
  automatic update) after upgrading rewrites every section once.
