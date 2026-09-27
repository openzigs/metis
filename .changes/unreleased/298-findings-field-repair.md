---
issue: 298
section: Fixed
---

- Analysis: one over-long field no longer invalidates a whole agentic findings answer. A citation
  `documentId` that names a known document by path or filename is resolved to its real id, otherwise
  it is removed; an over-long note is truncated with an ellipsis; every repair is logged and noted on
  the pass. The final-answer retry prompt now states the id format and the length limits.
