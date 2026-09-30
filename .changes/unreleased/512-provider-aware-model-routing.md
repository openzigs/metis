---
issue: 512
section: Fixed
---

- On a provider that cannot run Claude tier models (DeepSeek, OpenAI, Azure or a
  local runtime without a model-profile mapping for the tier), auto-mode
  specialist agents now run on the provider's configured model instead of being
  sent a Claude model id, and the analysis form's Model card names that model
  rather than "Claude Sonnet 5". Anthropic and the Bedrock gateway keep tier
  routing. No Claude price is quoted against a model that is not Claude.
