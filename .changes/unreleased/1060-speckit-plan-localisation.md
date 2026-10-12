---
issue: 1060
section: Fixed
---

- `/speckit.plan` and `/plan` now follow the code graph from the retrieved code to its
  data: the table's definition (the migrations file), the types named for it, its
  writers and readers, what they call (a query builder), and structural twins. No model call.
- The plan's context ends with the list of files it was given. `/speckit.plan` saves it as
  `plan-context.md`, and a plan that calls a listed file "not in the retrieved context" is
  reported in the result line.
- New admin setting `SPEC_KIT_PLAN_LOCALISATION_TOKEN_BUDGET` (default 2500; `0` turns it
  off). Anything left out for the budget is named, never dropped silently.
