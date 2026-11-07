---
issue: 1915
section: Added
---

- Measured: setting out-of-date code citations aside costs nothing after a routine
  refresh of the code that changes nothing. On the held-out localization eval
  (Claude Sonnet, 39 requirements), arms A7R and A7RD found the same files to edit on
  every requirement, because the refresh left every saved citation up to date. When
  the code does change, setting stale citations aside still lowers how well the files
  to edit are ranked, as #1834 found. The run records are committed, and a test pins the
  paired comparisons and the citation freshness counts against them.
