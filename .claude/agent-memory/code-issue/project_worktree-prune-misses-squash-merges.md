---
name: worktree-prune-misses-squash-merges
description: worktrees:prune calls squash-merged and alias-branch worktrees "active"; check the PR or issue state and remove clean ones by hand.
metadata:
  type: project
---

On 2026-10-01, `pnpm worktrees:prune --yes` removed nothing from 46 worktrees holding 116 GB. Its rule keeps a worktree as `active` unless the branch tip is an ancestor of `origin/main` or its upstream is gone. Both conditions fail for the common cases:
- A squash merge leaves the tip off `main`.
- A local alias branch such as `alias-622` or `pr680-fix` has no upstream to go `[gone]`.

**Why:** the prune rules predate squash merges and the alias-branch push pattern.

**How to apply:** list each worktree's branch, `git status --porcelain`, any agent-memory changes, and the issue number from its last commit. Remove the clean ones whose issue is CLOSED or PR is MERGED with `git worktree remove` (unlock first if needed), then `git branch -D`. Removing 41 that way freed 100 GB.
