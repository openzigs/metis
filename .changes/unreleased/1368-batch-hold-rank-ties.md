---
issue: 1368
section: Fixed
---

- A planned business-requirements batch over its share now keeps the smaller of equally ranked topics first when that keeps
  more of them; a less important topic still never stays while a more important one moves. Run B replay: whole themes lost
  44 → 38, and "Content Entities" and "Entry and Media Entities" are both written.
- Reuse: the batch-hold version is now 2, so a planned BRD's batched sections that are given a length are written once more
  on the next run (at most that run's catalogue section calls; under $0.70 of section calls on run B, plus their fact-check).
