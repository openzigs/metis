---
issue: 73
section: Fixed
---

- A test now covers the coverage service handing its cost guard to the judge. Without the guard the
  judge falls back to recording one total at the end and never checks the budget between batches, so
  a run could make every judge call past its cap — and the whole suite stayed green.
