---
issue: 1277
section: Fixed
---

- Document fact-checking (on Anthropic and the Bedrock gateway) and Spec Kit
  on the gateway no longer pay to write prompt-cache entries never read back.
- Parallel section parts wait for the first part only where the prompt is
  cached; on DeepSeek they start at once.
- Section prompts lead with shared text, for DeepSeek's cache. The first
  regenerate after this version rewrites every model-written section once, at
  model cost (only the 7 code-derived ones with no cross-module flow or data
  lineage); with auto-update on, any trigger pays it, e.g. a code change.
- New `pnpm cache:report` shows what prompt caching saved or cost per step.
