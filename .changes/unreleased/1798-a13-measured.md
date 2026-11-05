---
issue: 1798
section: Changed
---

- The LLM re-order of the files to edit (`IMPACT_LLM_EDIT_RERANK`, still **off**) is now measured
  on the held-out sets with `claude-sonnet-5-5`: Recall@5 rises from 0.53 to 0.70 pooled over
  39 requirements (significant), table precision holds, and it costs about $0.02 per
  requirement. Its fusion weight is fixed at 1 from the in-sample set. The flag stays off until
  the impact result shows the analyst the re-ordered list (#1762).
