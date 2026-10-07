---
issue: 248
section: Fixed
---

- Project usage counts each cached token once on OpenAI-compatible providers
  such as the Bedrock gateway, and agent-run cost and the budget ceiling no
  longer bill cached input twice there.
