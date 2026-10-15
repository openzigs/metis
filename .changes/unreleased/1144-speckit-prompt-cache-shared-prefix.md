---
issue: 1144
section: Fixed
---

- On Claude models, Spec Kit no longer pays for prompt-cache writes it never reads. The five
  `/speckit.plan` calls now share one cached copy of the constitution and project context: the
  first call writes it and the other four read it. Commands that make a single model call, such as
  `/speckit.specify`, no longer request a cache write.
