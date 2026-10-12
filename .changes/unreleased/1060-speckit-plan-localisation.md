---
issue: 1060
section: Fixed
---

- `/speckit.plan` and `/plan` now follow the code graph from the retrieved code to its
  data: the table's definition (the migrations file), the types named for it, its
  writers and readers, what they call (a query builder), and structural twins. No model call.
- The plan's context ends with the list of files it was given. `/speckit.plan` saves it as
  `plan-context.md` (a METIS record: not installed into the repository), and the result line
  says when the plan puts "not in the retrieved context" next to a listed file.
- New admin setting `SPEC_KIT_PLAN_LOCALISATION_TOKEN_BUDGET` (default 2500; `0` switches
  off the walk and its block only). Whatever a budget, list cap or time limit leaves out is
  counted and named in the block, the result line and `plan-context.md`.
- The walk is bounded for large repositories: it reads only what it follows, yields to
  other requests, and is skipped (and says so) after 5 seconds.
