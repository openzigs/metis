---
issue: 1108
section: Fixed
---

- "Tested by" no longer marks a requirement tested because its tests build a
  shared entry point (a constructor or router most of its callers are not named
  for, such as `NewHandler`). Such a link is shown as **Shared entry point**,
  never counts as tested, and the untested list says "Tested only through a
  shared entry point". Threshold: `TESTED_BY_ENTRY_POINT_MIN_TEST_CALLERS`
  (default 5).
