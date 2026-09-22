---
issue: 25
section: Changed
---

- Phase-1 fact extraction on a model that reasons by default (DeepSeek
  `deepseek-v4-pro` / `deepseek-flash`, or a `claude-*` name on DeepSeek's
  endpoint) now asks for `low` reasoning effort instead of the model's default,
  keeping the larger output cap as headroom. New admin setting
  `DOCS_GEN_PHASE1_REASONING` (`auto`, `provider-default`, `off`, `low`,
  `medium`, `high`); Claude models are unchanged by default.
