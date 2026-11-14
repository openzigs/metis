---
issue: 2509
section: Fixed
---

- Opening an analysis's Questions tab no longer starts the first questions: they are prepared, and
  charged to the run, when you press **Ask these questions**. A dialog you already began still
  continues on open (the next round, or a re-open for a waiting Needs BA input finding).
- The portfolio check sees each code excerpt whole, so a field near an excerpt's end is no longer
  missed ("the evidence could not be verified" for a product that has it).
- A finding that could not verify a requirement no longer links it to the code it cited (unless the
  check, not the model, downgraded an implemented claim).
- Traceability's "Spec coverage" column is now "In a generated spec"; Spec Kit features are not
  counted. A spec started from requirements says its criterion ids are its own, and "Start Spec
  Kit feature" says when it could not check whether Spec Kit is on.
