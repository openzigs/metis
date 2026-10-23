---
issue: 1108
section: Fixed
---

- "Tested by" no longer marks a requirement tested because its tests build a
  shared entry point (a constructor or router most of its callers are not named
  for, such as `NewHandler`). Such a link is shown as **Shared entry point**,
  never counts as tested, and the untested list and exported matrix say so. A
  test named for the code it calls keeps counting when that code's name shares
  a word with the requirement. Threshold:
  `TESTED_BY_ENTRY_POINT_MIN_TEST_CALLERS` (default 5, minimum 2).
