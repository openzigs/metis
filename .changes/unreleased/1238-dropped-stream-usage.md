---
issue: 1238
section: Fixed
---

- A chat answer retried after its connection to the model dropped now counts
  the dropped attempt's tokens in the usage ledger and budgets, once, when the
  provider reported them (Anthropic). When it reported none, nothing is
  estimated: the gap is recorded in the audit log as `ai.usage.unmetered`.
