---
issue: 739
section: Fixed
---

- Discussion @AI replies are grounded in the project: they use the project's knowledge search and
  read-only code tools like chat does, within a 4-step budget, cite `file:line`, and are told not
  to invent paths. The reply's spend is now recorded in the project usage ledger.
- @AI replies triggered from a linked Teams channel use the same project knowledge search (without
  code tools), and the prompt mentions excerpts or tools only when the reply actually has them.
