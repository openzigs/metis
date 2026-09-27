---
issue: 246
section: Fixed
---

- Documentation fact-checking no longer leaves a section silently unverified: a failed check gets
  a "NOT fact-checked" warning, is counted apart from spot-checks and is re-checked on
  regeneration, after dropped streams, 5xx, 429 and timeouts are retried. Phase 1 names each
  source file it could not read, with its remedy (#224); fact-check calls now count in token
  usage and run cost (#180); on an Anthropic-compatible endpoint that serves a thinking-by-default
  model (DeepSeek) they run thinking-off, which `DOCS_GEN_ANTHROPIC_GROUNDING_THINKING=1` reverts;
  real Claude models are sent no thinking setting (#247).
