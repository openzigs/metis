---
issue: 1155
section: Fixed
---

- A code finding whose citations were dropped as malformed now shows as unverified instead of
  having nothing to verify, and a run whose code findings were recovered from a broken answer
  counts the citations it lost, so it shows "completed with warnings".
- The analysis lists on the Requirements, Publishing, Workbench and Library pages show "completed with errors" or
  "completed with warnings" the way the run header does, instead of a plain "completed".
