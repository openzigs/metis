---
name: requirement-status-filters-must-be-label-aware
description: A requirement status filter or count on the reviewStatus column alone disagrees with resolveRequirementReviewStatus/heldReviewStatus, which read legacy review:* labels (#1016, #2420).
metadata:
  type: project
---

A Prisma `where` on the `reviewStatus` column alone disagrees with `resolveRequirementReviewStatus` / `heldReviewStatus`, which also read legacy `review:*` labels (#1016): a row can list under one status and count under another.

**How to apply:** every new requirement status filter or count goes through the label-aware resolver (or an equivalent `OR` over the labels). Test with a row that has the legacy label and a stale column (#2420).
