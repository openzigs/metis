---
issue: 2016
section: Fixed
---

- The exported clarifying-questions CSV now labels a company-policy question
  with the requirement it checks, instead of an internal id. A very long
  requirement no longer overflows the model's prompt budget when it is checked
  against company policy. A cancelled analysis stops checking the rest of its
  requirements at once. Opening the Questions tab while the AI provider is down
  no longer retries the same unsettled answer on every visit; retries are spaced
  out. Still behind the `GOVERNING_DOCS_ENABLED` setting, which is off by
  default.
