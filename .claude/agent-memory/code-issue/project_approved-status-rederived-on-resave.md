---
name: approved-status-rederived-on-resave
description: A requirement's approved status is re-derived on every re-save of the set, so a permission rule at the approval routes alone is bypassable; also, write-gating sweeps must cover every card component.
metadata:
  type: project
---

From the reviews of #1589 (#1588) and #1590 (#1587), 2026-10-30.

- **`approved` is re-derived on every re-save**: Regenerate (orchestrator re-persist),
  withheld-replacement apply, and the #723 append. A rule added only at the checkpoint
  approval routes is bypassed by whichever re-save path reads a *different* user's role.
  #1589's first cut used the run's starter, so a developer's Regenerate of a coordinator's
  run came back `approved`. The fix (`signOffForResave` in
  `server/src/lib/analysis/checkpoint-sign-off.ts`) needs both the recorded sign-off
  (`checkpointSignOff` analysis metadata) and the triggering actor's durable roles.
- **`checkpointApprovedRequirementIds` exempts rows from #769 review-work protection.**
  List only rows actually written `approved`; a draft row in that list let the next
  Regenerate silently replace a coordinator's later hub approval.
- **"Disable writes without permission X" issues list components by hand and miss some.**
  Grep the page for every component it renders and check each one's server route. After
  #1566 and #1587, `RequirementLinksPanel` (`project.update`) and `DataMappingsPanel`
  (`connector.write`) were still ungated (#1591).
- **Stacked PRs:** `codeql.yml` runs only for PRs to `main`, and GitHub *closed* (did not
  retarget) the stacked PR when `--delete-branch` removed its base. Recover by re-pushing
  the base branch, `gh pr reopen`, `gh pr edit --base main`, then rebase `--onto origin/main`.
