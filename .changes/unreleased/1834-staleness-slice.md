---
issue: 1834
section: Added
---

- The localization eval can now measure what happens when the code that the code agent's
  saved citations point at changes after the analysis. For each held-out requirement, a
  committed patch edits the functions of one file, renames one file and deletes one file in the test
  repository. The eval then re-reads the code, which re-checks the saved citations, and
  measures the files to edit with and without setting out-of-date citations aside (arms
  A7S and A7SD). Arm A7K checks that this changes nothing when no citation is out of date.
  The table-precision check reads the same arms. `pnpm eval:staleness-patches` writes the
  patches. A run with these arms refuses the in-sample set and stops before spending
  anything if a held-out set, its setup or a patch is missing.
