---
name: code-agent-budget-read-from-ledger-cache-pattern
description: How to diagnose agentic code-pass budget spend offline from token_usages (no transcripts are stored), and the compaction-churn defect it exposed (#766).
metadata:
  type: project
---

**No transcript is persisted.** For an agentic code pass, `agent_results.output.toolTelemetry`
gives call counts per tool and `analyses.metadata.retrieval.searchedScope` gives tool + path/query
(no line ranges, no result sizes). The per-turn shape lives only in the ledger: `token_usages`
rows for `sessionId = <analysisId>` between the code row's `startedAt` and `completedAt`, one row
per model call. `inputTokens` is UNCACHED input; `cacheReadTokens` is the cache hit. The budget
(`TokenBudget`, `ANALYSIS_AGENT_TOKEN_BUDGET` 100k) is charged `usage.totalTokens` = uncached input
+ output (`anthropic-provider.ts` `mapUsage`), so cache misses are what exhaust it.

**Read it this way.** Append-only turns show `cacheRead` growing to cover the previous prompt.
A turn whose `cacheRead` falls back to the system prefix (~10-14k) with 15-20k uncached input is a
prompt rewrite. Across 24 Miniflux passes (runs 3-9) 118 of 318 turns were such misses and
uncached input was ~93% of budget spend; the last 1-2 rows are the final answer / recovery calls
(16,384 output with no answer = the #1063 reasoning-ate-the-cap failure).

**Cause found (#766):** `compactTranscript` hysteresis fails when the irreducible floor (3
preserved batch results + assistant turns + stubs) exceeds the 60% target: every turn re-crossed
the ceiling and rewrote one message. Fixed by raising the trip point by `floor - target`.

**Measuring a compaction change offline:** drive the REAL `compactTranscript` with per-turn
result sizes taken from pre-compaction prompt deltas (median 2.6k, mean 3.2k tokens), counting
uncached tokens as everything after the first message that differs from the previous prompt.
Run with `server/node_modules/.bin/tsx <script>` importing the module by absolute path.

**Worktree guard:** shell `cd X && sqlite3 ... $VAR` or heredoc-plus-cd commands are refused;
put SQL in a Python script using `sqlite3.connect("file:...dev.db?mode=ro", uri=True)`.
