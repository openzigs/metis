---
issue: 1065
section: Fixed
---

- `/speckit.plan` writes `plan.md` first and gives it to the data model, contract and quickstart.
  A plan with no REST endpoint gets a contract with no paths instead of an invented one, and
  nothing is saved unless all five artifacts were generated.
- `/speckit.analyze` reads the contract and data model, and reports in `analysis.md` every
  contract endpoint the plan puts out of scope, never mentions or names under another method,
  and every `METHOD /path` the plan names that the contract does not define.
