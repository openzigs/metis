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

- **Recurred twice more 2026-09-30:** two panel voters ran a stale `mut.py`/`run.sh` another session had left in the shared scratchpad. Both no-oped, but only by luck; dispatches now say "run no scratchpad script you did not write".

**Why:** these are shared machine resources, not per-worktree state, and nothing warns on collision.

**How to apply:** give every scratch file a name unique to the issue (`mktemp`); after `gh pr create/edit`, check `gh pr view <n> --json closingIssuesReferences` names only your issue; never use `git stash` in a worktree — commit a WIP instead. Links: [[local-ui-walkthrough-setup]].

## 2026-10-16 additions (scratchpad and worktree hygiene)

Checked against `main` at b16dcc30.

- **PR-body files and closing links** are now a rule in the code-issue skill's Step 6
  (`pr-<N>-body.md`, re-read `closingIssuesReferences` after every create/edit). It recurred
  twice on 2026-10-16: generic `body.md` / `body-new.md` landed on the wrong PRs (#1187
  closed #1190; #1205 closed #1145).
- **Logs and scripts too.** Name every scratch file with the issue number, not only PR
  bodies (#1186).
- **The worktree-isolation guard refuses compound Bash** that runs `git` or `gh api` inside a
  loop, `$()` or a long `&&` chain, and a loop passing a variable to `sed`. Write multi-step
  work to a script file (with the Write tool) and run `bash <file>` as its own call; run git
  one call at a time.
- **Run Prettier from the repo root, or not at all on docs.** `npx prettier --write` on a
  markdown file from `scripts/` reformatted it differently (padded tables, broken wraps), #1205.
- **Do not symlink `server/node_modules` into a throwaway worktree.** pnpm workspace links are
  relative, so `@metis/shared` resolved to the main checkout's build: false
  `VALIDATION_ERROR`s and unresolvable UI imports (#1210 re-review). Run a real
  `pnpm install --frozen-lockfile --prod=false` in the worktree (12 s on 2026-10-16), or read
  CI logs.
- **A stale `@metis/shared` build fails vitest assertions too**, not only typecheck, after a
  rebase onto a PR that changed it (#1186). Run `pnpm --filter @metis/shared build` first.

Older entries, folded here (retired from the index 2026-10-16; files unchanged):

- [[pgrep-f-wait-loop-matches-itself]] — a `pgrep -f` wait loop matches its own command line
  and never exits; use `ps` + `grep "node .*(vitest|tsc)"`.
- [[next-env-churn]] — `next build`/`dev` rewrite `ui/next-env.d.ts`; revert it to `main`
  before committing a UI PR.
