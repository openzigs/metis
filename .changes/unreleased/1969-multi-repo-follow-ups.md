---
issue: 1969
section: Fixed
---

- Multi-repository projects: an impact result counts a path held by two repositories as two
  affected files (export and summary), and the AI check's verdict on one repository's file no
  longer marks the same path in another. A code citation is stamped with a repository's graph
  only when the repository can be told apart, never by row order. The borrow preview now lists a
  link into a file this requirement's analysis grounded as already linked, as the borrow skips it.
