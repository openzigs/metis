---
issue: 713
section: Fixed
---

- Model Preferences now lists the models your configured provider actually runs. On a provider that
  does not serve the Claude tier models, such as DeepSeek's Anthropic-compatible endpoint, the page
  offers that provider's configured model (for example `deepseek-flash`) instead of Claude models at
  Anthropic prices. Its price is shown only when you have set one in `MODEL_PRICES`. The budget
  downgrade setting now says it has no effect when there is no cheaper model to downgrade to.
