---
issue: 1823
section: Changed
---

- When you run an impact analysis on requirements you already evaluated with "Evaluate new
  requirements", the files Analysis's code agent cited for each requirement now lead the
  files to edit by default (`IMPACT_AGENT_SEEDS`, now on). On the held-out test set this
  found the right file in the top five noticeably more often. On the table test set its
  average table precision is within 0.03 of the same analyses without it; the 95%
  interval's lower bound is -0.043, so the interval does not fully clear that. It makes no
  extra AI call. An administrator can turn it off with `IMPACT_AGENT_SEEDS=0`.
