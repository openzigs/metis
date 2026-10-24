---
name: walkthrough-docs-describe-code-not-memory
description: Walkthrough TEST_PLAN/skill/brief edits must describe the code path and the page's controls, not memory of a run; archive notes need a grep per fact (#1172 review). Also what the plan gate cannot see (path-scoped commands, comparePhase string sort).
metadata:
  type: project
---

On PR #1173 (#1172) the review found walkthrough doc edits that described behaviour from memory of run 9 rather than from the code path. S24 said reopen "unticks" a task, but `toggleCheckbox` in `server/src/lib/spec-kit/issue-sync.ts` never ticks a table-form row: close writes `<!-- closed via #N -->` and reopen swaps it for `<!-- open -->`. S21 told the run to hand-cut `tasks.md` to 1 task, ignoring #993's `spec-kit-export-tasks` picker on the Spec Kit page. And an `ARCHIVE.md` retirement note said a memory file was "covered by" two skills when four of its facts appeared in neither.

**Why:** a wave agent scores against the doc's wording, so a wrong description produces a FAIL that is not one, or never exercises a supported control. `ARCHIVE.md` is never loaded, so an unchecked "covered by skill X" makes a fact unreachable.

**How to apply:** when writing or reviewing TEST_PLAN/skill/brief changes, open the cited function and the page's controls, not just the cited line. Before retiring a memory pointer with "covered by X", grep X for each fact in the file, and move any missing fact into X first.

## Plan checks that do not catch everything (2026-10-24)

- The walkthrough-plan gate (`scripts/verify-walkthrough-plan.mjs`, run by the `changelog` job)
  checks routes and pages only. Path-scoped shell commands in TEST_PLAN (e.g. wave G's
  `git diff --name-only … -- <paths>`) fail silently when a path is renamed, so each needs a
  test that its paths exist (#1505 review). New-route rule: [[publishing-guards-repo-identity-limiters]].
- `comparePhase` in `scripts/lib/walkthrough-slideshow-core.mjs` compares post-number text as
  strings (`"J1.10" < "J1.9"`). Use letter suffixes (`J1.4a`) for new journey steps until it
  is fixed (#1177).
