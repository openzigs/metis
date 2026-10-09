---
issue: 905
section: Fixed
---

- "Tested by" no longer counts a test file as a `direct` test when an analysis
  cited it as a document, with no lines and no symbol. Such a citation names no
  test, so a requirement it backs stays in the untested list.
- Through a config hub, the code's own-package tests now need to share the
  requirement title's words too. A config requirement mapped to the option
  constructor is no longer "tested" by the constructor's unrelated
  `TestConfigMap`.
