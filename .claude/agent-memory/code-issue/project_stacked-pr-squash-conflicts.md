---
name: stacked-pr-squash-conflicts
description: After the base of a stacked PR squash-merges, update-branch conflicts on every file both touched; resolve by hand in a worktree, keeping HEAD and unioning independent additions.
metadata:
  type: project
---

When a stacked PR's base squash-merges, GitHub's update-branch (and `gh pr merge` after retargeting) fails with conflicts on every file both PRs touched: the squash commit is a new SHA, so git cannot see the stacked branch already contains it. Seen on #1858, #1862, #1886, #1888, #1895 and #1898 in one session.

**Why:** the stacked branch's history holds the base's individual commits, main holds one squash of them, and their hunks overlap textually.

**How to apply:** `git worktree add -B merge-N origin/<branch>`, `git merge origin/main`, then per conflict keep HEAD (the stacked side is usually the superset) except where main added independent lines — `package.json` scripts and `index.ts` export lists take the **union**. Typecheck and run the touched suites, `git commit --no-edit`, push to the branch, and let CI re-run before merging. Never force a side wholesale without reading each hunk: main may hold a later fix to the same lines.
