---
issue: 1224
section: Fixed
---

- Reasoning `off` no longer fails every call on Claude Sonnet 5.5, where it now turns reasoning off. Claude Opus 5.5, Fable and Mythos cannot turn reasoning off: there `off` means the lowest effort, and that reasoning is still billed. A model that rejects a reasoning setting now says so in the document warning, naming the step that failed, instead of a generic failure.
