---
issue: 303
section: Fixed
---

- Analysis findings no longer keep a document citation that points at no document. The code
  agent's knowledge search now shows each result's real document id, and a citation whose id is
  a file name, or names a document outside the project, is either matched to the right document
  or removed. Each such repair is recorded in the run's notes.
