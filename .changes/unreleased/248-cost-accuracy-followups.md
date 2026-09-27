---
issue: 248
section: Fixed
---

- Project usage counts each cached token once on OpenAI-compatible providers
  such as the Bedrock gateway, and agent-run cost and the budget ceiling no
  longer bill cached input twice there.
- A test-coverage run accepts a per-run `budgetCents` cap and reports it from
  its budget endpoint; fields the server does not act on are now a 400.
