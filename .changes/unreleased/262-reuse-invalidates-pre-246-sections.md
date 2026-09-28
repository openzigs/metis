---
issue: 262
section: Fixed
---

- Regenerating a document no longer reuses a section saved before the
  fact-check fix in #246. A section whose fact-check failed back then was
  saved with no warning, so reusing it showed an unchecked section as
  verified. Every section saved in that format is now written and
  fact-checked again once, on the next regeneration. Sections saved since
  then are still reused as before.
- A document whose latest version holds section-reuse data in an older
  format (saved before #152) can be regenerated again. Before this fix,
  reading that version's record failed, so the regeneration stopped.
