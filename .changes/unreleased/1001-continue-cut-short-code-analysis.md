---
issue: 1001
section: Added
---

- When code analysis runs out of its token budget before reaching every
  requirement, the analysis now says so in the "Some analysis capabilities were
  limited" banner, and offers **Continue with a larger budget**. Continuing
  re-runs the code analysis with twice the configured budget; once it finishes
  within budget the warning clears.
- The cost-cap endpoint now also reports `agentBudget`, the per-agent token
  budget that actually limits code analysis. The `agentCap` value it already
  reported (80,000 by default) is informational and never limited a run.
