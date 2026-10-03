---
issue: 794
section: Fixed
---

- Test coverage saves the LLM judge's verdicts, so judged requirements count toward coverage
  instead of every run reading 0%.
- Coverage counts requirements, so a reviewer override moves the percentage and leaves the
  gap list. Click a matrix cell to override it, with a reason.
- The matrix and gap list show requirement and test names, colour cells by verdict and show
  the judge's confidence or cosine instead of a ~0.02 rank score.
- Suggestions map only to real requirements, and run spend reaches the project usage ledger.
