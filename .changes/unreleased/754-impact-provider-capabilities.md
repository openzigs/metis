---
issue: 754
section: Fixed
---

- Impact analysis no longer treats the model provider as supporting nothing. Its metering
  wrapper now passes through the provider's capabilities and router-model check, so impact
  stages see the same structured-output, tool-call and caching support as the real provider.
