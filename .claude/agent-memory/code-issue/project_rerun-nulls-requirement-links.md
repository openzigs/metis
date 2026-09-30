---
name: rerun-nulls-requirement-links
description: Re-running analysis hard-deletes requirements; draft links go null
metadata:
  type: project
---

persistRequirements hard-deletes requirement rows on every re-run, and IssueDraft.requirementId is ON DELETE SET NULL (#485, #490).

**Why:** Any draft-to-requirement match must tolerate a null link after a re-run; matching by requirementId alone loses signed-off drafts.

**How to apply:** Match drafts by content key as well as id, and test a re-run between two Generates.
