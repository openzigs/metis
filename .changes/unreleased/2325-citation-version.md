---
issue: 2325
section: Added
---

- A chat citation of the project's code now shows which version of the code it was read at: the
  short SHA of the indexed commit, with the GitHub link pinned to that commit. A citation with no
  recorded commit, including every answer from before this change, says "version unknown". When the
  project's index is behind the repository, a file the answer read is marked "index is behind the
  repository"; it is still listed and counted. Chat's code and knowledge search results, file reads
  and the automatic code context state the indexed commit too, and a file read cut at 200 lines
  names the range to read next.
