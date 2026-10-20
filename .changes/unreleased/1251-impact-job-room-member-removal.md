---
issue: 1251
section: Security
---

- A member removed from a workspace stops receiving live progress for that
  workspace's impact analyses and other jobs straight away, rather than after
  their browser reconnects. The same now happens when a project is deleted or
  a workspace is deleted.
- Opening a product that spans many projects no longer costs several database
  reads per project.
