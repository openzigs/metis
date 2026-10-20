---
issue: 1251
section: Security
---

- A member removed from a workspace stops receiving its job progress updates
  (impact analysis, analysis and document-generation jobs) at once, not on
  reconnect; likewise when a project or workspace is deleted.
- Opening a product that spans many projects costs one database read, not
  several per project.
- Deleting a usage override is recorded in the audit log with its author.
