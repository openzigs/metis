---
name: unread-answer-is-not-empty
description: Since #1081 an unreadable model answer is a marked result, not the empty one; test stubs that answered "{}" now read as unread and must return a legitimately empty envelope.
metadata:
  type: project
---

Since #1081 every model-JSON caller distinguishes "could not read the answer" from
"the model found nothing": the analysis callers return `unread` (via
`requestStructuredVerdict`), clarification throws `502 MODEL_REPLY_UNREADABLE`, the
impact stages return `unreadable` and the route calls
`ImpactLlmRuntime.markUnreadable(stage)`.

**Why:** a malformed reply is a SUCCESSFUL provider call. The impact runtime's
#1024 notice counted calls, failures and timeouts only, so a run whose every answer
was garbage read as fully enriched; the cross-doc panel said "no gaps" for a check
that never answered.

**How to apply:**

- A new model-JSON caller returns a distinguishable marker on parse failure and has
  a test where the reply is malformed twice (not the empty value) AND one where the
  reply is a legitimately empty envelope (still empty, not marked).
- Test doubles that answered `"{}"` to every prompt now produce unread markers or
  extra re-prompt calls. The fix is in the stub, not the code: route by system
  prompt and return the empty envelope (`{"questions":[]}`, `{"nfrs":[],...}`), as
  `tests/analysis-orchestrator.test.ts` `makeProvider` and the `providerChat` stub in
  `tests/analysis-routes.test.ts` now do.
- A provider error is not an unread answer: the impact runtime already counts it as
  a failure; mark only parse/shape failures.
