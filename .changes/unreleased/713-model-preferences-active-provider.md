---
issue: 713
section: Fixed
---

- Model Preferences now lists the models your configured provider actually runs. On a provider that
  does not serve the Claude tier models, such as DeepSeek's Anthropic-compatible endpoint, the page
  offers that provider's configured model (for example `deepseek-flash`) instead of Claude models at
  Anthropic prices. Its price is shown only when you have set one in `MODEL_PRICES`. The budget
  downgrade setting now says it has no effect when there is no cheaper model to downgrade to.
- Model Preferences no longer calls a model "cheaper" or "most expensive" by its routing tier:
  Claude Fable 5 was labelled "Faster and cheaper" at the highest price on the list. Those words
  now appear only where the listed prices bear them out. Saving a Claude model on a provider that
  does not run it is rejected. A saved model the current provider does not run, after a switch in
  either direction, now shows and saves as Auto, with a notice naming the saved model.
