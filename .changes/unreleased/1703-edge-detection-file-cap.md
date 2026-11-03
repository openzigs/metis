---
issue: 1703
section: Fixed
---

- Integration-edge detection on a large repository finds edges in its source
  code again. The limit of 500 files per repository used to count every text
  file, so README files, docs, lockfiles and data could use it up before the
  code was reached. Only files detection can use (API specs and source code)
  now count, and docs, data and assets are not read at all. A repository that
  now fits within the limit is read in full, so edges that are no longer found
  there are removed again.
- Detection stops reading a repository once its byte budget is all but spent,
  rather than opening every remaining file, so `/analyze` on a very large
  repository returns sooner.
