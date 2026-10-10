---
issue: 995
section: Fixed
---

- Document length limits (`DOCS_GEN_SECTION_MAX_CHARS`, `DOCS_GEN_DOCUMENT_MAX_CHARS`) now count
  a document as the reader gets it, with each citation as its short footnote reference and the
  footnote list included. They used to count the long internal source ids the model writes before
  footnotes are rendered, so a citation-heavy BRD was cut to about 189k characters of its 250k and
  left out over a hundred topics it had room for.
