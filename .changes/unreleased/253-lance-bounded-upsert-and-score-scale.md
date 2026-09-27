---
issue: 253
section: Fixed
---

- LanceDB ingest cost per chunk no longer grows with the table: an upsert deletes
  only ids that exist, an `id` index keeps that lookup bounded, and the approval
  path compacts again. `search()` scores are the exact cosine above and below the
  1,000-row index threshold, so fixed score thresholds mean the same thing on a
  large project (#277).
