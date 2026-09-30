---
name: squash-title-closes-issues
description: A PR body that says "Refs #N" still closes #N if the PR title (the squash commit subject) says "Resolve #N".
metadata:
  type: project
---

PR #378 deliberately said `Refs #282` because an acceptance criterion was unmet, but its title was "docs: Resolve #282 — …". `gh pr merge --squash` uses the title as the commit subject, and GitHub closed #282 from that keyword on the default branch. It had to be reopened by hand.

**Why:** GitHub closes issues from closing keywords in commits landing on the default branch, not only from the PR body.

**How to apply:** when a PR should only reference an issue, keep "Resolve/Close/Fix #N" out of its title, or pass `--subject` to `gh pr merge`; confirm with `gh issue view N --json state` after merging. Links: [[parallel-agents-share-scratch-and-browser]].

**Converse (2026-09-30):** a "Resolve #N" squash title did not auto-close #439 (PR #461) or #430 (PR #462), and `closingIssuesReferences` read `[]` on every PR from #451 to #462. After every merge, check `gh issue view N --json state` and close the issue by hand if it is still open.
