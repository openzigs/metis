---
issue: 1925
section: Fixed
---

- `eval:localization`: the A7S-against-A7 and A7SD-against-A7S table-guard gates now hold on
  both scorings (the first persisted requirement and every persisted requirement unioned), as
  A7 against A7O does. A7R or A7RD on a corpus that is not materialized is refused, not read as
  A7K. An A7R/A7RD-only run no longer needs a staleness patch set, and `--table-guard` binds
  the table corpus only for A7S/A7SD. `--merge` checks each `--reference` against every
  corpus's recorded arms, before `--table-guard` spends. A restore failure is no longer dropped
  when the read threw a primitive. The per-corpus A0 table now sizes its detectable gap on the
  fewest paired items and names an arm that pairs fewer, as the reference tables do. The docs
  no longer say a no-op re-ingest leaves only `fresh` or `moved` citations.
