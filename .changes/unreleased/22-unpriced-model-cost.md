---
issue: 22
section: Fixed
---

- Usage from a model METIS has no price for is recorded as unpriced instead of $0 or at Claude Sonnet
  rates. Both usage tables price from one source, the usage pages show unpriced tokens separately, and
  administrators can set per-model prices with `MODEL_PRICES`.
- Behaviour change: with `ANTHROPIC_BASE_URL` on any host but `api.anthropic.com`, Claude usage is
  unpriced unless `MODEL_PRICES` prices it; a proxy or gateway relaying to Anthropic sets
  `ANTHROPIC_BASE_URL_BILLS_AS=anthropic` to keep list prices. An autopilot cost ceiling now refuses
  to run while the month has unpriced usage, because unknown spend cannot be shown to be under it.
