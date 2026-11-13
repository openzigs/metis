---
issue: 2397
section: Fixed
---

- `eval:ba-qa`: the report's seconds per answer now stop before the judge's call ("Seconds per
  answer (judge excluded)"); earlier runs timed the judge too, and the README says so where it
  quotes them. `--routing-sweep` reads top k only over the questions answered in at most k
  products, so a question answered in two products no longer counts as a top-1 miss (14/14 at
  nine products, not 14/18). `--route` without `--routing-scope` is refused in every mode,
  including `--routing-sweep` and `--floor-sweep`, which ignored it. The README states both
  routing latency measurements (the sweep's and the paid runs'), and that the paid runs' faster
  routed retrieval did not reproduce. The routing set's path guard and alias bounds are tested.
