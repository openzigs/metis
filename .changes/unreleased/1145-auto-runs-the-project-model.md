---
issue: 1145
section: Fixed
---

- An analysis started with Model override **Auto** now runs every agent on the project's model
  (its AI model setting, else the provider's configured model) instead of sending the document,
  database and single-shot code agents to Claude Haiku 4.5 or Sonnet 5 by task depth. A
  per-project default model or task-type override on the Models page still applies.
- On the Anthropic API the analysis Model override and the project Models page now offer the
  current Claude models (Sonnet 5.5, Haiku 5.5, Opus 5.5 and the others the API serves).
