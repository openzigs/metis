---
name: traceability-tab-imports-and-paging
description: Where the analysis Traceability tab lives, how tracker-imported requirements are marked, and why server paging needs a unique tie-break in the source orderBy (#1448 and its review).
metadata:
  type: project
---

From #1448 and its review (2026-10-23).

- **The Traceability tab** is the four panels in `ui/src/app/(authed)/projects/[id]/analysis/page.tsx`
  `TabsContent value="traceability"`, not `components/traceability/traceability-view.tsx` (that is the
  per-requirement panel).
- **Imported requirements** carry `importSourceId` under an analysis whose
  `metadata.kind = "import"`; `reviewStatus` is NULL until approved.
- **Paging is only as stable as the source query's `orderBy`.** Several readers
  (`getAnalysisSnapshot` orders by `createdAt` only; `requirement-diff-service.ts`
  `defaultLoadRequirements` has none) need a unique tie-break before `sliceListPage`
  (`lib/analysis/list-page.ts`).
- Route guards for the new `/projects/:projectId/...` routes: see
  [[project-access-guard-wiring]].
