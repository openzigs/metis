---
issue: 2363
section: Fixed
---

- `eval:ba-qa`: `--include` refuses a version 1 results file, written before citation precision
  was split by check, instead of re-summarising its out-of-file line citations as span-checked.
  The BA question set is now version 2, after S1.c's rewording, so a run graded on the old
  wording cannot be included beside one graded on the new.
  The three #2264 scope-9 readings, run on the reworded set, are relabelled version 2.
