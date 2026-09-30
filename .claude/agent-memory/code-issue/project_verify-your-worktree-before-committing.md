---
name: verify-your-worktree-before-committing
description: Agents in this harness have been handed another agent's worktree
metadata:
  type: project
---

Three times on 2026-09-30 an agent worked in a checkout that was not its own: the #327 implementer was given a finished panel voter's worktree and moved its HEAD; the #529 fix ran in a stale voter worktree that held the PR branch; a code-review agent ran git checkout in the main checkout. A worktree lock did not prevent it. The stash list is also shared, and one agent popped another's stash (#368).

**Why:** Wrong-checkout edits land commits on another branch or move HEAD under a running voter.

**How to apply:** Before the first commit, compare `git rev-parse --abbrev-ref HEAD` with the branch you were given; find a PR branch's worktree with `git worktree list`, never by the agent-<issue> name; never `git stash pop`; never git checkout in the repo root.
