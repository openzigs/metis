---
name: chat-tool-withholding-and-stream-retry
description: Since #1139 chat creates sessions on first send, withholds approval-gated tools with no approver, and retries dropped streams; test and design traps from PR #1234.
metadata:
  type: project
---

Collected from #1139 / PR #1234 and its review and panel (2026-10-17).

**Behaviour since #1139.**
- `/chat` creates its session on the first send. A spec that needs a session must send a message (`ui/tests/chat-send.ts`).
- Mocks of `recent-tracker` must spread `importOriginal`.
- `POST /api/ai/chat`, with nobody subscribed to the session's socket room, withholds approval-gated tools. A test that checks the full tool list must send `awaitToolApproval: true`.

**The gate is not a backstop for withheld tools.** `executeToolCall` looks the tool up in the toolset before the approval gate runs (`server/src/lib/ai/tool-runtime/executor.ts`). Check that order before trusting "the gate still catches it" for a tool removed from the offer.

**Filtering a toolset.** `makeToolset(kept, …)` drops the removed tools from the map that treats `-` and `_` as the same, so a withheld tool's other spelling could resolve to a kept tool (#1240). Pass the removed names in as blockers, as `withheldBySpelling` does.

**Retry side effects.** `withTransientRetry`'s `isRetryable` runs before the backoff sleep, so a side effect there fires even when a Stop cancels the retry. Put side effects in the retried function, gated on `attempt > 1`.

**UI test traps.**
- Two `fireEvent.submit` calls in a row do not test a same-tick double send, because React flushes discrete events synchronously. Dispatch both inside one `act()`.
- Mocking `useProjectScope` to "All projects" models a state that the real hook reaches only for a user with no project. Run the real hook, as `ui/tests/chat-page-unscoped-resume.test.tsx` does.
- `ui/tests/chat-page-*.test.tsx` assert `resumeChatSession` is called with exactly `(id)`. Adding an argument on the stored-chat path fails five suites: pass new options only on the `?sessionId=` path, or update those assertions (#1428).

**Usage ledger.** When a dropped stream is retried, the dropped attempt's tokens are not counted, because providers report usage only at stream end (#1238).
