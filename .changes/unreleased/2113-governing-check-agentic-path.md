---
issue: 2113
section: Fixed
---

- Governing documents are now checked on analyses of projects with ingested code. Those analyses
  run the code agent in agentic mode, which never started the governing check, so their Governing
  rules panel stayed hidden even when the workspace had current rules. The check now runs beside
  the agentic code agent and is joined after synthesis, as it already was without a code graph.
- An analysis with no governing findings now says why in the Governing rules panel: either the
  rules were checked and none produced a finding, or the check did not run (the workspace had no
  current governing rules, or the run skipped it). `GET …/governing-findings` carries a `checked`
  flag for the same distinction.
