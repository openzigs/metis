---
issue: 43
section: Fixed
---

- Test-coverage runs record their judge and suggestion usage under the provider and model that served
  it, instead of always `bedrock-gateway`. Their usage now reaches the AI usage records at all: every
  row previously failed a database constraint and was dropped.
- A test-coverage run whose model has no price stops further LLM work after the call that reveals it,
  instead of treating the unknown spend as $0 against its budget. The run's budget line shows the
  unpriced tokens.
