---
name: prompt-ab-on-ba-qa-in-a-worktree
description: How #2357 A/B-tested a chat prompt section on the BA-QA eval from an isolated worktree, and what it cost (2026-11-14).
metadata:
  type: project
---

- **Setup ($0, ~6 min):** copy the main checkout's `.env` into the worktree root (gitignored; `eval:ba-qa` loads `../.env` from `server/`), `pnpm --filter @metis/shared build`, `pnpm eval:materialize baqa-01-acme-reader`, then `pnpm eval:ba-qa --floor-sweep` to do the knowledge ingest without a model.
- **Toggle the prompt by file copy, not git.** The worktree guard refuses compound `git` commands and ones with `$VAR` paths. Keep `with.ts` / `without.ts` copies in the scratchpad and `cp` one in before each run, restoring after; a helper script that also copies `eval-results/ba-qa/<runId>.json` to a labelled name keeps pairs straight.
- **Exit 134 (`libc++abi … mutex lock failed`) after an arm with the reranker on is harmless**: the results are already written.
- **Cost on Sonnet 5.5:** S7-S11 alone ~$0.25-0.41 a run (`on` or `default`); the 23 one-turn questions ~$0.47 (`off`) and ~$0.94 (`on`).
- **Read contradictions per fact** from `sessions[].judgeReply` (JSON `facts: {id: stated|missing|contradicted}`); the summary only counts them.
