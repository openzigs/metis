---
issue: 1965
section: Changed
---

- Impact analysis API: `editCandidateFiles` and `blastRadiusFiles` are now
  `{ repoConnectionId, filePath }` objects instead of path strings, and each affected symbol
  carries `repo` (`{ id, name }`, or `null` when unknown). A client that read them as strings
  must read `filePath`.
