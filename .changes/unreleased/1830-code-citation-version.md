---
issue: 1830
section: Added
---

- Each code link that an analysis saves for a requirement now records which version of the code it
  was read from (the repository's code graph and its commit) and whether it has been checked since.
  Links saved before this change, and links added by hand, read as "not yet checked". In a project
  with several repositories that share a file name, the link names the repository the analysis
  actually read. This is the groundwork for flagging out-of-date code links.
