---
name: imported-item-provenance-is-already-recorded
description: Which imported item a requirement came from is already recorded (#1063 sourceIds → sourceCandidateIds); read it before writing a word-overlap heuristic that will disagree with the "Added by the analysis" badge.
metadata:
  type: project
---

Provenance of imported items is already recorded: synthesis returns `sourceIds` checked by `cleanSourceIds` (`server/src/lib/analysis/synthesis.ts`, #1063), `matchSynthesized` (`server/src/lib/analysis/approved-requirement-set.ts`) joins them onto the structured requirements, and promotion persists them as `Requirement.sourceCandidateIds` (`promote-requirements.ts`), which drives the "Added by the analysis" badge (`ui/src/components/analysis/RequirementSourceItems.tsx`).

**Why:** PR #1157 (#1129) first split "ticked vs added" approvals with a second word-overlap join (containment >= 0.5). The adversarial panel showed the two disagree: ticked "Per-feed refresh interval" vs added "Refresh all feeds / trigger a refresh of every feed" scored 0.5 and was filed ticked while the badge said added, and `POST reject-added` acted on the heuristic.

**How to apply:** any feature that asks "did this requirement come from an imported item?" classifies from recorded provenance first (`sourceIds` non-empty → from an item; `[]` → added) through the same `matchSynthesized` join, and falls back to words only when nothing was recorded (degraded synthesis). One classification for every surface. See `classifyRequirementOrigins` in `server/src/lib/analysis/imported-scope.ts`.
