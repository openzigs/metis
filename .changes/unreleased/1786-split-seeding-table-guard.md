---
issue: 1786
section: Fixed
---

- `pnpm eval:localization --arms A0,A4 --table-guard` now measures A4's table precision on the
  seeding the edit-candidate check runs on (the split hybrid seeding), next to A0 measured on that
  same seeding, and gates A4 against it. Before, A4 had no table-precision reading, and running it
  on the mapper path would have reported A0's numbers under A4's label. Every table-precision
  reading in the report now says which seeding produced it.
