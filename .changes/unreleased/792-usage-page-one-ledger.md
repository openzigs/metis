---
issue: 792
section: Fixed
---

- The project usage page now reads one ledger. Analytics, the agent-step chart, **Export CSV** and
  the Token Budget Status gauge used to read a different table from the cards (10.8M tokens / $5.57
  beside 290k / $0.14); they now count the same calls. Per-user budgets still read the per-user
  store. Each CSV row now names its project.
- Impact-analysis LLM spend now counts toward the project usage summary and token budget.
- Usage recorded before this release shows under an "unknown" step and an "unattributed" user.
  PR-review spend appears under the "pr-review" step.
