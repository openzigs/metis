---
issue: 2024
section: Added
---

- `eval:governing`: a new held-out set, `governing-02-clinic-records` (a fictional clinic
  network's records and safety standard: 40 obligations, 36 requirements), built from
  documents no prompt was tuned on. Two AI labellers of the same model, blind to every arm
  and prompt, agreed on 31 of 40 listed pairs (0.78). A third pass settled each disagreement
  and a consistency pass per cross-cutting rule added eight pairs. No person has reviewed it.
  `governing-01` is now the tuning set, every report names its set, `--baseline` refuses a
  held-out set, and a content hash (also recorded in ANNOTATION.md) guards against edits.
