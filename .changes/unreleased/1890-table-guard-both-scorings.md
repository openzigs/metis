---
issue: 1890
section: Changed
---

- The localization eval's table-precision check for arm A7 now has to hold against its
  control A7O on two readings of the same runs: the analysis's first saved requirement,
  and every saved requirement combined. Before, it read only the first, so a drop
  confined to the further requirements an analysis saves could pass unseen. The report
  says which reading decided the result. A damaged run record with a requirement
  missing from its per-requirement tables is now refused by name instead of crashing.
