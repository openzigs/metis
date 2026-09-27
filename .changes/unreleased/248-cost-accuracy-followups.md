---
issue: 248
section: Fixed
---

- Project usage counts each cached token once on OpenAI-compatible providers
  such as the Bedrock gateway, and agent-run cost and the budget ceiling no
  longer bill cached input twice there.
- A test-coverage run accepts a per-run `budgetCents` cap, which may only lower
  the operator's `TESTCOVERAGE_BUDGET_CENTS` cap, and reports it from its budget
  endpoint; a higher cap, or a field the server does not act on, is a 400.
