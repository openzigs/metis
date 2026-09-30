---
issue: 512
section: Fixed
---

- On a provider that cannot run Claude tier models (DeepSeek, OpenAI, Azure or a
  local runtime without a model-profile mapping for the tier), auto-mode agents
  and the analysis form's Model card now use the provider's configured model
  instead of a Claude model id, and a forced tier resolves the same way on the
  run as on the card; Force Fable and Force Opus send their Claude model id.
  Anthropic's API, the Bedrock gateway and a proxy declared with
  `ANTHROPIC_BASE_URL_BILLS_AS=anthropic` keep tier routing; any other
  Anthropic-compatible host uses its configured model. No Claude price is
  quoted against a model that is not Claude.
