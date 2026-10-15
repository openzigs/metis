---
name: requirement-version-history-is-incomplete
description: Clarification enrichment, import re-sync and review-service write tracked requirement fields with no requirement_versions row, so reversed "pinned" snapshots include those writes.
metadata:
  type: project
---

Requirement version history is incomplete. `server/src/lib/analysis/clarification-enrichment.ts:451` (body), `server/src/lib/importers/import-service.ts:782` (re-import title/body/priority/type/labels) and `server/src/lib/reviews/review-service.ts` (reviewStatus, ~:406 and ~:556) write tracked fields with no `requirement_versions` row or version bump. Any "pinned" snapshot rebuilt by reversing recorded changes from the current row silently includes those writes. Filed as #1162; found by the adversarial panel on PR #1159 (#1130).

**Why:** a snapshot rebuilt from history looks authoritative but is not; with zero rows it is simply the current row.

**How to apply:** never label a reversed or zero-row snapshot as "pinned" or "as created" — `originalVersionOf` returns `source: "reversed" | "current"` for that reason. When adding a writer of a `TRACKED_FIELDS` field, go through `updateRequirementWithHistory`.
