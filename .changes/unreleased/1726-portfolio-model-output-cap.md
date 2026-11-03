---
issue: 1726
section: Fixed
---

- A portfolio check run on a reasoning model (DeepSeek `deepseek-flash`, for example) no longer
  returns nothing for a repository. Each model call now has room for the model's reasoning:
  21,000 output tokens by default, set with `PORTFOLIO_MAX_OUTPUT_TOKENS`, where it was 2,000
  for a repository and 3,000 for the report. A reply cut off at that cap is retried once with a
  larger one. When a repository's check still fails, the page says *"The check failed (model
  error) on … ; re-run to retry"*, not *"the evidence could not be verified"*. The answer at the
  top says it leaves that repository out, and the product still names the repositories that were
  checked and do not cover the requirement. A repository that belongs to several products is
  checked once per assessment, and every product holding it gets the same verdict.
