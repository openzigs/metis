---
issue: 1798
section: Added
---

- Impact analysis can let one model call re-order the head of the files to edit
  (`IMPACT_LLM_EDIT_RERANK`, **off** by default). The model orders the search's candidate pool
  and cites a line for each pick. A pick is kept only when that line is inside a named function
  or type of that file in the code graph. The final order fuses the search's order with the
  model's, and every file the search picked stays listed. The run summary says how many files
  moved and how many picks were dropped. The call is metered as `impact.edit-rerank`.
- `pnpm eval:localization` gains three arms that measure the re-order: `A13` (on A0's order),
  `A13C` (on A12's cosine order) and `A13S` (the pool shown shuffled, to read position bias).
  `--table-guard` reads A13's table precision on the split seeding.
