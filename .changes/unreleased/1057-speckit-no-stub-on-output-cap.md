---
issue: 1057
section: Fixed
---

- A Spec Kit reply that hits the output-token limit before any text, or is
  empty, now fails (`SPEC_KIT_OUTPUT_EXHAUSTED` / `SPEC_KIT_EMPTY_OUTPUT`) and
  keeps the previous artifact instead of saving a stub.
- A plan reply cut off part-way no longer replaces a complete plan artifact
  (the partial text is returned in `partialContent`), and a cut-off `plan.md`
  no longer marks the feature `planned`.
- New admin settings `SPEC_KIT_MAX_OUTPUT_TOKENS` (default 21333, clamped to
  the model's ceiling) and `SPEC_KIT_REASONING` (default `auto`: `low` effort
  for a model that reasons by default; Claude gets no reasoning change).
