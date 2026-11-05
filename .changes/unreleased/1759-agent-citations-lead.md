---
issue: 1759
section: Added
---

- Impact analysis can put the files Analysis's code agent cited for a requirement ("Evaluate
  new requirements") at the top of the files to edit, behind `IMPACT_AGENT_SEEDS` (**off** by
  default). It applies to a run started from tracked requirements, reuses the citations the
  analysis already stored (no extra AI call, no extra time), keeps every file the search found
  with its score, and skips a cited file that is no longer in the code. The run summary says
  how many citations were used and skipped. Measured on the held-out sets (#1755): the
  citations alone raise Recall@5 by 0.31 on `claude-sonnet-5-5`.
