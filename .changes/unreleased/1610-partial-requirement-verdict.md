---
issue: 1610
section: Added
---

- Requirements can now read **Partially implemented**: code meets at least one
  acceptance criterion and a gap is confirmed for another. METIS works this out
  from the findings linked to each criterion, never from a model guess, and a
  criterion it could not check never counts as met. Requirements without
  per-criterion evidence, and earlier runs, keep the verdict they had.
