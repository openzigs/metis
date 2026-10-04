---
issue: 737
section: Fixed
---

- Generated documents: cited grounding sources now render as numbered footnotes, numbered once per document. Each one names the module path, or `file:line` for a symbol source. They replace stripped, empty `(,,,)` or URL-encoded references. The model is also told not to write its own per-section source keys.
