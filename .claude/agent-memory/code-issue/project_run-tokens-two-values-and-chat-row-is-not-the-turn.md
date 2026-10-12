---
name: run-tokens-two-values-and-chat-row-is-not-the-turn
description: A run's tokens have two legitimate values (with and without cache); stored totalTokens columns are finish-time snapshots; use summariseLedgerRows. A chat turn's ledger row is not the whole turn. One cost definition per page - the stored ledger cost
metadata:
  type: project
---

**A run's tokens have two legitimate values**: input + output without cache, and
`totalTokens` with cache reads and writes. Both are right; a page that shows one
without naming it will disagree with a page showing the other (#1007: 215.4k in
a list, 479.8k in the header for one run).

**The stored `agent_runs.totalTokens` / `analyses.totalTokens` are finish-time
snapshots** and miss later spend: 0 while the run goes, blind to a deep dive,
regenerate or clarification round afterwards (339,834 of one run's 576,834
tokens), and short of calls the orchestrator's accumulator never adds. Use
`summariseLedgerRows` (`server/src/lib/finops/ledger-usage-summary.ts`) over the
run's `token_usages` rows, scoped to the run's project AND session.

**A chat turn's row is not the whole turn.** The turn writes one row for the chat
model's calls (`chat`, `chat-estimated`, `chat-failed`). Sub-agent
(`routes/ai.ts`, `subagent`), apply-diff (`ai/tools/apply-diff.ts`,
`chat.apply-diff`) and compaction (`async/compaction.ts`, `compaction`) calls
write SEPARATE rows in the same session, tied to the conversation by the session
id only. Do not claim "one row per turn is the turn's cost", and do not invent an
attribution to a turn: report them per session. `discussion*` and `impact.*`
rows live in backing sessions of their own, never in a user's chat session.

**One cost definition per page** (review of #1112). `/runs` re-priced rows at the
current rate card while the chat-turn table and the analysis header showed the
stored ledger cost: $3.01, 301 cents and $1.50 + 100,000 unpriced tokens for one
session. The definition is the STORED cost, `COALESCE(costUsd, costCents/100.0)`
(`ledgerRowCents`), with rows recorded unpriced shown as "N unpriced tok", never
priced at today's rates. If a re-priced figure must be shown, label it an
estimate at current rates, never under a bare "Cost".

**How to apply:**
- Any new surface showing a run's or a session's spend: `summariseLedgerRows`,
  both token figures named, cost from the same summary.
- A test comparing surfaces must seed a row whose stored cost differs from
  today's rate card AND a row stored unpriced; otherwise a re-pricer and a
  stored-cost reader agree by coincidence.
- `ledgerRowCents` rounds each row to 1e-8 USD, so a row sum differs from
  `SUM(costUsd)` in SQL by up to about 1e-7 USD per hundred rows; compare to 6
  decimal places, not 12.
- Chat sessions are owner-only (`loadAuthorizedSession` filters `userId`, admins
  included); anything listing per-session chat detail must filter on
  `ai_sessions.userId` as well as project access.
