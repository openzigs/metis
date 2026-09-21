---
name: worktree-hygiene
description: "Manages the throwaway git worktrees that multi-agent work leaves under .claude/worktrees/agent-*. Use when asked to clean up, prune, or list stale worktrees, when `pnpm worktrees:prune` output needs interpreting or something you expected to be removed was skipped, when `git worktree` reports a path as locked or already checked out, or when setting up isolated worktrees so several implementers can run in parallel without clobbering one branch."
argument-hint: "[prune | isolate] — clean up stale agent worktrees, or set one up for an implementer"
---

# Worktree hygiene

Parallel implementers **must** be worktree-isolated: two agents sharing one checkout
clobber each other's branch and `HEAD`. This is a rule, not a tip — the recorded failure
mode is real, and it stopped recurring the moment isolation became universal: **~13 parallel
`code-issue` agents in one session, zero branch/HEAD collisions** (#1147). Isolation buys
that safety at the cost of leftover directories, which this skill cleans up.

## Isolating an implementer

```bash
git fetch origin
git worktree add .claude/worktrees/agent-<id> -b <branch> origin/main
```

An agent running inside `.claude/worktrees/agent-*`:

1. Runs `git worktree lock .` (any reason string) **immediately** — a locked worktree is
   never pruned, not even with `--force`, so this is what protects live work (#992).
2. Uses absolute paths under its own worktree for every git operation.
3. **Commits anything it writes under `.claude/agent-memory/`.** That directory is tracked,
   and a memory left uncommitted exists only inside a throwaway worktree — one had to be
   rescued by hand into PR #1140 (#1147). Safety rule 4 below now blocks that deletion, but
   the fix is to commit it.
4. Runs `git worktree unlock .` before finishing.

### Two consequences that look like bugs and are not (#1147)

Both were hit repeatedly across one session's parallel agents:

- **`gh pr merge --squash --delete-branch` reports failure, but the merge landed.** Git
  cannot delete a local branch that a worktree still has checked out, so the command fails
  *after* merging. Seen on 4+ PRs. Confirm the truth before reacting:
  ```bash
  gh pr view <pr> --json state,mergedAt,mergeCommit
  ```
  `state: MERGED` means done — remove the worktree, then delete the local branch.
- **A fresh worktree's `@metis/shared` build is stale, so new exports look missing.**
  `pnpm typecheck` reports an export that is plainly in `packages/shared/src`. Fix:
  `pnpm --filter @metis/shared build`. This produced five false diagnoses in one session
  (also noted in `CLAUDE.md`'s build gate — it is the single most expensive red herring
  here).

## Pruning stale worktrees

```bash
pnpm worktrees:prune            # dry run (the DEFAULT) — prints what would go, and why
pnpm worktrees:prune --yes      # actually remove, subject to every safety rule below
pnpm worktrees:prune --force    # also override rules 2, 3 and 4 (never rule 1)
pnpm worktrees:prune --help     # full usage
```

It considers **only** `.claude/worktrees/agent-*` paths, and never the current worktree or
the primary checkout. Safety rules apply in this order — #986 exists because the original
#916 heuristic twice deleted worktrees that were still in active use, having mistaken "no
upstream by design" for "abandoned":

1. A **locked** worktree is **never** pruned. No flag overrides this.
2. A `worktree-agent-*` branch with **no upstream** is skipped unless `--force` — those
   branches are ephemeral by design, not merged-and-stale.
3. A worktree whose directory was modified in the last **2 hours** is skipped unless
   `--force`.
4. A worktree holding **uncommitted or untracked files under `.claude/agent-memory/`** is
   skipped unless `--force`, and the run prints each pending path so it can be committed
   (#1147). `--force` still removes it, but names the files it is destroying rather than
   deleting them silently. A probe that cannot run counts as "something to lose" and also
   skips. Outranks rule 3, because "commit the memory" is an action, not a wait.
5. Otherwise it is pruned when its branch merged into `origin/main`, its upstream is
   `[gone]` (squash-merge + `--delete-branch`), or it is detached.

Every run prints a reason per decision — prunes *and* skips — plus a one-line summary. If
something you expected to be removed was skipped, that reason names the rule; re-read it
before reaching for `--force`.

## Where the logic lives

- `scripts/lib/worktrees-prune-core.mjs` — pure, unit-tested decision logic
  (`classifyWorktree()`, with `shouldPrune()` as a thin boolean wrapper).
- `scripts/worktrees-prune.mjs` — the CLI wrapper.

Change a rule in the core module, not in the CLI, and cover it with a unit test.
