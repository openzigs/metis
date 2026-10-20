---
issue: 1251
section: Security
---

- A member removed from a workspace stops receiving its per-job progress
  updates (impact analyses, analyses, document generation) at once, not on
  reconnect; likewise when a project or workspace is deleted. Analysis runs,
  discussion threads, connector and background-run progress, and presence are
  still checked only when the browser subscribes.
- Opening a product that spans many projects costs one database read, not
  several per project.
- Deleting a usage override is recorded in the audit log with its author.
