---
issue: 1330
section: Fixed
---

- The Affected code panel names the rule that decided each requirement's links. When the code was
  ranked by meaning but the two-shared-words rule decided (another embedding model, or code still
  being embedded), it no longer describes the 0.08 confidence floor.
- While a project's code is still being embedded, one shared word no longer gets a code link shown.
- On keyword-only runs the code agent gets the same starting code, with the same confidences, as
  before the change to absolute confidence.
- Impact Analysis: a caller reached only through a weaker match now reads lower, scaled by that
  match. Callers of the best match are unchanged.
- The verbs "goes" and "does" no longer match code named "go" or "doe".
