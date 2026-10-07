---
name: panel-required-on-full-pr-diff
description: compute shouldRunAdversarialPass on the whole PR diff (origin/main...tip), never on a follow-up commit's own diff.
metadata:
  type: project
---

A review-fix agent on PR #683 (#651) reported `required: false` because it checked only the files of its own follow-up commit. On the full PR diff the panel was required, triggered by `revocation-relay.ts`.

**Why:** the requirement applies to the change being merged, not to the last commit.

**How to apply:** run the check with `$(git diff --name-only origin/main...<tip>)` before deciding to skip the panel.
