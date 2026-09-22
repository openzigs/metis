---
issue: 22
section: Fixed
---

- Usage from a model METIS has no price for is recorded as unpriced instead of
  $0 (chat, impact analysis) or at Claude Sonnet rates (documentation
  generation). Both usage tables now price from one source; the usage pages
  show unpriced tokens separately; administrators can set per-model prices with
  the `MODEL_PRICES` setting. Anthropic list prices are no longer applied when
  `ANTHROPIC_BASE_URL` points at another provider.
