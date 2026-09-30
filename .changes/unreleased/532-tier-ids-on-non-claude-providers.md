---
issue: 532
section: Fixed
---

- Finding deep-dives, clarifying-question grounding, the clarification dialog and the code
  scanner no longer send a Claude model id (Haiku or Sonnet) to a provider that cannot serve it.
  On DeepSeek, OpenAI, Azure or a local runtime they now run the provider's configured model, the
  same rule the Model card and analysis runs follow since #512.
