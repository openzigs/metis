---
issue: 782
section: Fixed
---

- A documentation run that fails late no longer throws away its finished sections. Each section is
  saved as it is written. A first-time document is kept as degraded with those sections and a
  Regenerate button. A document with a published version keeps that version.
- A failed or partial document now says where it stopped (stage, section and error class) instead
  of "the details are in the server log".
- Regenerate reuses every finished section whose inputs are unchanged, so that work is not billed
  again.
