---
issue: 199
section: Fixed
---

- Chat no longer presents generated-document excerpts as authoritative. Each excerpt
  from a generated document is now labelled as derived material (with its status and
  scope when degraded or not full), and the system prompt calls retrieved excerpts the
  primary source only for unlabelled material.
