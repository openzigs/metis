---
issue: 860
section: Fixed
---

- "Tested by" no longer counts unrelated tests through config hubs. When tests
  in at least `TESTED_BY_HUB_MIN_TEST_FILES` (default 5) different files
  exercise a requirement's file-level mapping, as happens with a config file,
  an `exercises` link counts only if the test or the symbol it calls shares
  two words of the requirement's title. A mapping to one exact symbol is not
  filtered. A requirement such as OIDC now shows up as untested again when
  nothing actually tests it.
- A file mapping with a line range now covers only the symbols in that range,
  not the whole file. A test file cited only for its licence header or imports
  is no longer a `direct` test of the requirement.
