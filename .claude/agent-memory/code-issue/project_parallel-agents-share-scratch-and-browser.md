---
name: parallel-agents-share-scratch-and-browser
description: Parallel subagents share the session scratchpad, /tmp, the git stash list and the Playwright browser profile; fixed file names and localhost cookies collide.
metadata:
  type: project
---

Measured on 2026-09-29 with up to eight parallel implementers:
- **Scratchpad/tmp:** three implementers each wrote their PR body to `scratchpad/pr.md`. Two PRs (#366, #359) were then edited with another PR's body, including its `Closes #N`, so merging would have closed the wrong issue. Recovered from GitHub's `userContentEdits` history.
- **git stash:** the stash list is shared by every worktree; `git stash pop` in one worktree tried to apply another session's entry.
- **Playwright MCP profile:** `localhost` cookies ignore the port, so one agent's `metis.at` cookie authenticated another agent's stack as a user from a different database (500 FK on create). Drive the UI at `127.0.0.1:<port>`.

- **Recurred 2026-09-30:** the #552 implementer `git stash pop`ped the #574 agent's entry into its tree; it restored it within a minute. Dispatch prompts now say "never use `git stash`".

**Why:** these are shared machine resources, not per-worktree state, and nothing warns on collision.

**How to apply:** give every scratch file a name unique to the issue (`mktemp`); after `gh pr create/edit`, check `gh pr view <n> --json closingIssuesReferences` names only your issue; never use `git stash` in a worktree — commit a WIP instead. Links: [[local-ui-walkthrough-setup]].
