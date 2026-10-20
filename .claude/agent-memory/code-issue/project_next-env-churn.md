---
name: next-env-churn
description: ui/next-env.d.ts is rewritten by next build/dev and keeps landing in UI PRs by accident; revert it to main.
metadata:
  type: project
---

`ui/next-env.d.ts` is generated. On main it imports `./.next/dev/types/routes.d.ts`; a `next build` switches it to `.next/types/routes.d.ts` plus `root-params.d.ts`, and the next `next dev` flips it back. PR #834 (#803) committed the build variant as unrelated diff noise (found in code review).

**Why:** it is churn with no effect, and it obscures the real diff.

**How to apply:** before committing UI work, run `git diff origin/main -- ui/next-env.d.ts`; if it changed, `git checkout origin/main -- ui/next-env.d.ts`.

## A Playwright run from a worktree dirties two more paths (#1285)

A Playwright run from a worktree writes 4 generated JSON files to `e2e/fixtures/llm/` (not gitignored), and `next build` rewrites `ui/next-env.d.ts`. Clean both before committing. Use `E2E_UI_PORT`/`E2E_API_PORT` when 3101 is taken.
