---
issue: 792
section: Fixed
---

- The project usage page now reads one ledger. "Detailed Usage Analytics", "Token Usage by Agent
  Step" and **Export CSV** used to read a different table from the cards, so one page could show
  10.8M tokens / $5.57 and 290k / $0.14 side by side. All of them, and the Token Budget Status gauge, now draw on the ledger behind the
  cards, so every figure on the page counts the same calls. Per-user budgets still read the
  per-user store. Each CSV row now names
  its project.
- Impact-analysis LLM spend now counts toward the project's usage summary, month-to-date figure and
  token budget. It was recorded only in the per-user store and never reached them.
- Usage recorded before this release has no agent step or user on the project ledger. The usage
  page shows that usage under "unknown" step and an "unattributed" user. PR-review spend now
  appears under the "pr-review" step.
