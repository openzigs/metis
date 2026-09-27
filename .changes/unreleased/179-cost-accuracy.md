---
issue: 179
section: Fixed
---

- Project usage cost no longer bills cached input twice on OpenAI-compatible
  providers such as the Bedrock gateway: cache reads are priced once, at the
  cache-read rate, matching the per-user usage table.
- The test-coverage budget reports the cap a run actually ran under (stored on
  the run) and its spend while it runs and after a failure, not only at the end.
- The test-coverage budget tile says whether unpriced spend came from an
  embedder (a lower bound, run continues) or from a judge/suggestion model (LLM
  work stopped), and how to price it.
