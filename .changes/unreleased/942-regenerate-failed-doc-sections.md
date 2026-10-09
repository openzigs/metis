---
issue: 942
section: Fixed
---

- A generated document that was published with a failed section can now be regenerated. The
  document page names the failed sections, shows why each one failed (the error class when the
  failure is not a recognised provider or budget error) and offers "Regenerate failed sections",
  which writes only those sections and reuses every finished one whose inputs have not changed.
  Before, regenerate answered 409 `DOC_NOT_REGENERATABLE` and the page offered no button, although
  the warning told the user to regenerate.
