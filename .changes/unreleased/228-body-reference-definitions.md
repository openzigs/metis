---
issue: 228
section: Fixed
---

- In the document viewer, reference-style links (`[text][ref]`) and footnote
  references (`[^1]`) now render as links and footnotes wherever their
  definitions sit in the document, instead of showing as literal bracketed
  text when the definition is in a later section.
- Footnotes appear in one list at the end of the document, numbered in reading
  order, instead of a separate list (with repeated ids) under every section
  that defines one.
