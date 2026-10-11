---
issue: 1037
section: Fixed
---

- A failed Spec Kit command now says why in the toast as well as the error card, with the
  server's error code, instead of "The Spec Kit operation failed". `/speckit.constitution` and
  `/speckit.specify` with nothing after them say what to type and are not sent.
- When a cut-off reply was not saved because a complete version exists, the result card shows
  the unsaved text and the toast is a warning.
