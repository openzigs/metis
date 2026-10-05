---
issue: 860
section: Fixed
---

- "Tested by" no longer counts unrelated tests through config hubs. When tests
  in at least `TESTED_BY_HUB_MIN_TEST_FILES` (default 5) different files
  exercise a requirement's mapped code, as happens with a config file or a
  constructor that every test calls, an `exercises` link counts only if the
  test or the symbol it calls shares the requirement's words. A requirement
  such as OIDC therefore shows up as untested again when nothing actually
  tests it.
- A file mapping with a line range now covers only the symbols in that range,
  not the whole file. A test file cited only for its licence header or imports
  is no longer a `direct` test of the requirement.
