---
issue: 1848
section: Fixed
---

- The localization eval's table guard for the analysis path (arms A7 and A7O) now scores
  the first requirement each analysis persists, its restatement of the labelled one. Before,
  it unioned the tables of every requirement the analysis wrote, about five per analysis,
  against that one label. Measured that way, "Evaluate new requirements" looked like it
  cost about 0.2 table precision. On its restatement it gains 0.15 to 0.18 on
  claude-sonnet-5-5. The union is still reported. An A7 run whose stored-citation lookup
  fails, as on an eval database that predates a migration, is now refused instead of
  being recorded as if the flag were off.
