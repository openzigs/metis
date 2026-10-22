---
name: code-agent-early-stop-is-a-toolless-reply
description: How to tell why an agentic code pass stopped early, offline, and the #1388 cause (a tool-less non-answer ended the loop).
metadata:
  type: project
---

**Where the stop reason lives.** The server log (`logs/dev-server.log` in the main checkout, not
the worktree) carries `Final-answer retry completed {turnsExhausted, budgetExhausted, ...}` and
one `Tool call executed {turn: N}` line per call. `turnsExhausted:false, budgetExhausted:false`
with a retry means the loop BROKE on a reply `parseToolCalls` did not read as a call and the
schema gate did not accept as an answer. The ledger shows the same: the last loop row has tiny
output (~100 tokens), then a big row whose `cacheReadTokens` falls to the system prefix (the
retry rebuilds the system prompt WITHOUT tools, so its note says "no tool access remained" —
that is FINAL_ANSWER_INSTRUCTION's wording, not a tool gate).

**#1388 fix.** `runAgentLoop` takes `continuation: {maxNudges, nudge}`; the code pass uses
`buildCodePassContinuation` (code-pass-coverage.ts). `assessShallowCodePass` sets
`codeAgentDegraded` + a `DEGRADED (#769):` note (the card badge reads that prefix) for a
non-exhausted pass with >50% unverified or starved under half budget.

**Test fallout to expect.** Pipeline fixtures whose code answer has no `verdict` count their
requirements unverified, so they now get one coverage nudge (an extra code call) and the
degraded note/reason. `buildCodeAgentJson(..., "implemented")` keeps a fixture clean. A
`*token*` key inside a `log.*({...})` call - even in a comment followed by a colon - trips
`tests/logger.enumeration.test.ts`.

**From the #1399 review and cycle 2.**
- `runAgentLoop` turns send no `maxTokens`, so a long findings JSON written inside the loop
  is cut at the provider default (4096 on the OpenAI-compatible adapters). An in-loop re-ask
  policy should skip a truncated-JSON reply and leave it to the final-answer retry, which has
  the raised cap.
- A `codeRetrievalDegraded` run can now omit the `code-retrieval-degraded` reason when
  `codeAgentStoppedEarly` is set and no other pass degraded retrieval
  (`analysis-capability.ts`). Tests for a starved or mostly-unchecked pass should expect
  `code-agent-degraded` instead, unless its searches errored.
