---
issue: 1330
section: Fixed
---

- The Affected code panel names the rule that decided each requirement's links, and why the keyword
  rule did when the code was ranked by meaning: another embedding model, tables and columns (never
  embedded), or code not embedded yet. It no longer describes the 0.08 floor for links it did not decide.
- A symbol with no usable embedding (such as code still being embedded) no longer gets a link shown
  for one shared word; links beside it that the embeddings measured keep the 0.08 floor.
- On keyword-only runs the code agent gets the same starting code, with the same confidences, as
  before the change to absolute confidence.
- Impact Analysis: a caller reached only through a weaker match now reads lower, scaled by that
  match. Callers of the best match are unchanged.
- The verbs "goes" and "does" no longer match code named "go" or "doe".
