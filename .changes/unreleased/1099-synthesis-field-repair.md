---
issue: 1099
section: Fixed
---

- One malformed value in a synthesized requirement (for example story points
  written as `null` or `3.5`, or an over-long label) no longer discards every
  requirement in the model's answer. Only that value is left out, defaulted or
  shortened, and the requirements view lists what was changed so it can be
  checked before publishing.
