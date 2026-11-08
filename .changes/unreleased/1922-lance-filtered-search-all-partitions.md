---
issue: 1922
section: Fixed
---

- Knowledge searches narrowed to some documents or to the active embedding model no longer
  come back short on a large project. Once a project's LanceDB table passed 1,000 chunks and
  was indexed, a filtered search looked only at the parts of the index nearest the question,
  so a few documents whose chunks sat elsewhere returned fewer hits than asked for, or none.
  A filtered search now looks at the whole index, which costs about 2 ms per search on a
  50,000-chunk project.
