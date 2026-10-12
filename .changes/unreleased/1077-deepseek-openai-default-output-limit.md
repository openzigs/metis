---
issue: 1077
section: Fixed
---

- DeepSeek through its OpenAI-format endpoint no longer returns empty or cut-off answers when a
  step sets no output limit: such a call now asks for up to 65,536 tokens instead of 4,096,
  which DeepSeek's reasoning used up (4 of 12 extraction calls failed). Other OpenAI-compatible
  servers keep 4,096, and a step's own limit still applies.
- Measured: DeepSeek's JSON mode gave no gain in JSON reliability over its Anthropic-format
  endpoint on requirements extraction, so that endpoint stays the recommended setup.
