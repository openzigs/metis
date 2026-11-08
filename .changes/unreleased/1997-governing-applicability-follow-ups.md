---
issue: 1997
section: Changed
---

- Working out which governing rules apply to each requirement no longer holds
  up the rest of an analysis: it now runs alongside the code check and the
  later steps instead of before them. It is also more selective: it no longer
  attaches rules every system must meet, such as encryption or retention, to
  requirements that create nothing new of that kind. When the rules cannot be
  loaded, each requirement now records that, so it is not mistaken for "no
  rule applies". Still behind the `GOVERNING_DOCS_ENABLED` setting, which is
  off by default.
