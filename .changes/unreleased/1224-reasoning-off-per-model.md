---
issue: 1224
section: Fixed
---

- Reasoning `off` no longer fails every call on Claude Sonnet 5.5: it is sent as `between_tools` there, and on models that cannot turn reasoning off (Opus 5.5, Fable) as the lowest effort. A model that rejects a reasoning setting now says so in the document warning instead of a generic failure.
