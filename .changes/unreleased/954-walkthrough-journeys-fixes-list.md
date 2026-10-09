---
issue: 954
section: Added
---

- The end-to-end walkthrough gains a wave F of persona journeys: an analyst and
  a developer each reach an outcome in the UI only, within a time and cost budget.
- `scripts/walkthrough/fixes-since.mjs` lists the fixes a run should verify (PRs
  merged since the last run, plus its unconfirmed fixes); `fill-brief.mjs` fills
  the wave briefs from it and refuses an unfilled or incomplete brief.
- `run.json` records the METIS SHAs and a verdict per fix, and the run-report
  deck shows "Fixes confirmed this run".
