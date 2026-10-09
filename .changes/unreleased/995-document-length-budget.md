---
issue: 995
section: Fixed
---

- A generated document now uses its whole length budget (`DOCS_GEN_DOCUMENT_MAX_CHARS`): room a
  shortened section cannot use is passed on to the other shortened sections, instead of every
  section being held to an equal share while the document comes in well under its cap. The
  Provenance panel of a document version lists, by section, every topic a length limit left out.
