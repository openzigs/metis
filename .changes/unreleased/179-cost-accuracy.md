---
issue: 179
section: Fixed
---

- Project usage cost no longer bills cached input twice on OpenAI-compatible
  providers such as the Bedrock gateway: cache reads are priced once, at the
  cache-read rate, matching the per-user usage table.
