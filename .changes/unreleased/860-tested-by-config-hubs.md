---
issue: 860
section: Fixed
---

- "Tested by" no longer counts unrelated tests through config hubs. When tests
  in at least `TESTED_BY_HUB_MIN_FOREIGN_TEST_DIRS` (default 2) directories
  other than the mapped code's own call it, as other packages' tests call a
  config constructor for setup, such a test counts only if its name or its
  callee's shares the requirement title's words. Tests in the code's own
  package always count.
- A ranged file mapping now covers only the symbols in its range. A test file
  cited only for its licence header (bound to its module symbol) is no longer a
  `direct` test.
