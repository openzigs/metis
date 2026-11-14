---
issue: 2509
section: Fixed
---

- Opening an analysis's Questions tab no longer runs the model: questions are prepared, and
  charged to the run, only when you press **Ask these questions**.
- The portfolio check sees each code excerpt whole, so a field near an excerpt's end is no longer
  missed ("the evidence could not be verified" for a product that has it).
- A finding that could not verify a requirement no longer links it to the code it cited.
- Traceability's "Spec coverage" column is now "In a generated spec"; Spec Kit features are not
  counted. A spec started from requirements says its criterion ids are its own, and "Start Spec
  Kit feature" says when it could not check whether Spec Kit is on.
