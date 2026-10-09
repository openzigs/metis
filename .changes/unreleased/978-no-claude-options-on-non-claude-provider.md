---
issue: 978
section: Fixed
---

- On a deployment whose provider serves no Claude models (DeepSeek, for one), the analysis page's
  Model override now offers Auto and the configured model instead of Force Haiku, Sonnet, Fable and
  Opus, and Settings → Provider preferences shows the active provider's model instead of
  `claude-sonnet-4.5`. Starting an analysis, or asking for a model recommendation, with a forced
  Claude tier that provider cannot run is now refused with a 400 (`MODEL_NOT_SERVED`) that names the
  model it does run, rather than silently running that model instead.
