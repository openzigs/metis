---
name: verify-your-worktree-before-committing
description: Agents in this harness have been handed another agent's worktree
metadata:
  type: project
---

Three times on 2026-09-30 an agent worked in a checkout that was not its own: the #327 implementer was given a finished panel voter's worktree and moved its HEAD; the #529 fix ran in a stale voter worktree that held the PR branch; a code-review agent ran git checkout in the main checkout. A worktree lock did not prevent it. The stash list is also shared, and one agent popped another's stash (#368).

**Why:** Wrong-checkout edits land commits on another branch or move HEAD under a running voter.

**How to apply:** Before the first commit, compare `git rev-parse --abbrev-ref HEAD` with the branch you were given; find a PR branch's worktree with `git worktree list`, never by the agent-<issue> name; never `git stash pop`; never git checkout in the repo root.

**Recurred 2026-10-16 (#1214 review):** a reviewer ran `git checkout --detach` in the main
checkout; it was restored by hand. The code-review skill's Step 1 now says to use a scratch
worktree (`git worktree add`) and never `git checkout` in the main checkout (#1215).

**Retiring this pointer was wrong once (PR #1178, 2026-10-16).** It was moved to `ARCHIVE.md` as "superseded by CLAUDE.md's worktree-isolation rule". Review found that none of the checks above appear in CLAUDE.md, the skills or the agents, and the pointer was restored. Before retiring any pointer as superseded, `git grep` each of its concrete checks in `CLAUDE.md`, `.github/skills`, `.claude/agents` and `.github/instructions`. A general rule does not supersede a lesson whose own text says the general measure failed (here: "a worktree lock did not prevent it").

**Stacked PR after its base squash-merges (#1254).** `git rebase --onto origin/main <old-base-tip>`, then confirm `diff <(git diff <old-base> <old-tip>) <(git diff origin/main HEAD)` is empty before pushing.

**`git checkout -- <file>` after a mutation test discards your own uncommitted edits too** (#1262 main session, #1265 implementer, 2026-10-19). Commit the fix before mutating, or reverse the sed in place.
