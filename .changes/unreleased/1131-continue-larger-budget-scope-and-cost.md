---
issue: 1131
section: Fixed
---

- "Continue with a larger budget" now re-investigates only the requirements the code analysis never reached, keeping its findings, and asks first: it states what it re-runs, its token budget and an estimated cost from this run's own figures. The banner shows the rerun in progress.
- Requirements the code agent reached but could not verify are named inconclusive and no longer offer Continue; a run whose every requirement is grounded shows no budget banner.
