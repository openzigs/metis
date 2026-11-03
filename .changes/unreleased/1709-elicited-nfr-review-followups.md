---
issue: 1709
section: Fixed
---

- Applying a withheld re-synthesis no longer leaves an elicited non-functional
  draft next to a new requirement that states the same thing in other words.
  The review now gives the reason each requirement is kept, so it no longer
  guesses from the review state. After applying, the message says "N kept"
  rather than "N reviewed kept", because elicited drafts are kept without
  review. The "already stated" check treats plurals, *-ion*, *-ed* and *-ing*
  forms, and `DB` for database as the same subject word.
