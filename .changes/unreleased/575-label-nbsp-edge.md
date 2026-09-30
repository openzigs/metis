---
issue: 575
section: Fixed
---

- The document viewer no longer trims a non-breaking space from the edge of a
  reference-link or footnote label. `[x ]` with a trailing non-breaking space
  and `[x]` are different labels to the renderer, but the section splitter
  treated them as one, so a sectioned document could leave a reference as
  literal text that a whole-document render resolves.
