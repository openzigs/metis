---
issue: 172
section: Fixed
---

- The batched Calculations section no longer drops extracted formulas past its
  80-entry block: a module with more formulas than one batch holds is split
  into labelled parts, so every formula reaches exactly one call.
