---
issue: 860
section: Fixed
---

- "Tested by" no longer counts unrelated tests through config hubs. When tests
  in at least `TESTED_BY_HUB_MIN_TEST_DIRS` (default 5) directories exercise a
  mapping, even a single symbol such as a config constructor, a link counts only
  if the test or its callee shares the requirement title's words. A requirement
  such as OIDC now shows up as untested again when nothing actually tests it.
- A ranged file mapping now covers only the symbols in its range. A test file
  cited only for its licence header (bound to its module symbol) is no longer a
  `direct` test.
