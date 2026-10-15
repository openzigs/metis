---
name: closes-link-cannot-be-unlinked-file-follow-up
description: A PR whose body says "Closes #N" but defers an acceptance criterion cannot be unlinked by editing the body; file a tracking follow-up issue before merging.
metadata:
  type: project
---

A PR with "Closes #N" that defers one of #N's acceptance criteria will close #N on merge; editing "Closes #N" out of the body afterwards does not remove the closing link (`closingIssuesReferences` keeps it).

**Why:** on PR #1157 (#1129) a review item was deferred to a follow-up while the PR still closed #1129; the deferred work would have vanished with the closed issue had #1160 not been filed. Same shape as [[squash-title-closes-issues]].

**How to apply:** when a PR defers any criterion, file the tracking follow-up issue (naming the criterion and the PR) BEFORE merge and link it from the PR body; check `gh pr view <n> --json closingIssuesReferences` rather than trusting the body text.
