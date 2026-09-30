---
issue: 512
section: Fixed
---

- On a provider that cannot run Claude tier models (DeepSeek, OpenAI, Azure or a
  local runtime without a model-profile mapping for the tier), auto-mode
  specialist agents now run on the provider's configured model instead of being
  sent a Claude model id, and the analysis form's Model card names that model
  rather than "Claude Sonnet 5". A forced tier (Force Haiku, Sonnet, Fable or
  Opus) resolves the same way on the run as on the card, so the two agree, and
  Force Fable and Force Opus now send their Claude model id rather than the
  literal override name. Anthropic's own API and the Bedrock gateway keep tier
  routing; any other Anthropic-compatible host or proxy uses its configured
  model. No Claude price is quoted against a model that is not Claude.
