---
name: portfolio-phase1-review-lessons
description: Durable findings from the #1608 phase-1 reviews (#1609-#1612, #1615) and the follow-redirects waiver (#1635) - memoized access checks, repo provenance, TRACKED_SELECT, waiver lifetime, re-runs.
metadata:
  type: project
---

From the reviews of PRs #1631-#1634, #1637 and #1638, 2026-10-31.

- **Memoized execution-time access checks (#1609):** an access hook described as "per
  project" but memoized once per run is a check at run *start*. When a route builds an
  access closure for a fire-and-forget engine, its JSDoc and ARCHITECTURE.md tend to claim
  more than the memo does.
- **Repo provenance (#1611):** each per-connector agentic code run does a project-wide
  fused retrieval (`retrieveFusedCodeContext` has no connector scope), but `read_file_slice`
  reads only that connector's clone. Paths found by tools and paths from fused chunks may
  come from different repos; never stamp a repo from a tool-found path. Any dedupe keyed on
  file:line must include the repo (`gap-report.ts`, `codeCitationKey`).
- **Versioned fields (#1612):** a Prisma `select` for tracked fields must spread
  `TRACKED_SELECT` (built from `TRACKED_FIELDS`). A hand-listed select silently reads a
  newly tracked field as null and rebuilds history wrong.
- **Dependency-audit waivers (#1635):** a re-run of a `pull_request` check reuses the old
  merge commit, so a waiver landed on `main` reaches an open PR only after
  `gh pr update-branch`. The follow-redirects bump PR must delete both the
  GHSA-mrwp-f3q8-3g9p entry in `sast.yml` and `scripts/lib/follow-redirects-1635-waiver.test.mjs`.
- **Stacked/parallel PRs on one schema (#1610 + #1612):** both added a field in the same
  three places (`packages/shared/src/analysis.ts` synthesis schema, `approved-requirement-set.ts`
  join, the `prompts.ts` JSON template). Expect that conflict; keep both, mind the comma.
