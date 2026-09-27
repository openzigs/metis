---
issue: 254
section: Fixed
---

- Spec Kit on a project with its own AI provider now calls that provider's
  endpoint with that provider's credential and default model, as chat does; one
  the server cannot build is refused, never sent to the global provider. The five
  `AI_STREAM_*` millisecond settings use the shared strict parser (plain digits,
  max 2147453647), so `1.2e6` or an over-limit value keeps the default and warns
  instead of becoming a 1 ms timer (#257).
