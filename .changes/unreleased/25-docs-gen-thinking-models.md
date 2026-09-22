---
issue: 25
section: Fixed
---

- Documentation generation on a model that reasons by default (DeepSeek
  `deepseek-v4-pro`, `deepseek-flash`) no longer truncates sections at 8,192
  tokens: output caps now add reasoning headroom
  (`DOCS_GEN_REASONING_ALLOWANCE_TOKENS`). An unparseable faithfulness-judge
  batch is retried once, and Phase 1 keeps `DOCS_GEN_PHASE1_CONCURRENCY`
  modules in flight as a pool, now an admin setting.
