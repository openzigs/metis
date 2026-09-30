---
name: logical-import-pass1-commits-early
description: Logical import pass 1 commits rows before later steps
metadata:
  type: project
---

logical-import.ts writes pass-1 rows with createMany and no enclosing transaction (#531). Sanitising uploadPath after the load left the untrusted value stored when the import later failed.

**Why:** A later fix-up step does not protect a failed import.

**How to apply:** Sanitise or refuse untrusted fields before batch.push, and test the failure path (e.g. a manifest row-count mismatch).
