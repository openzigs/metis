---
issue: 1277
section: Fixed
---

- Document fact-checking and Spec Kit plans on the Bedrock gateway no longer
  pay to write prompt-cache entries that are never read back.
- Parallel section parts wait for the first part only on Claude with a
  cacheable prompt; on DeepSeek they start at once.
- Section prompts lead with the text every section shares, for DeepSeek's
  cache. A section written before this release is rewritten once on its next
  regeneration.
- New `pnpm cache:report` shows what prompt caching saved or cost per step.
