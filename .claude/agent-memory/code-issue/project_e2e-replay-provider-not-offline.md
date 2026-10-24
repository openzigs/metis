---
name: project_e2e-replay-provider-not-offline
description: e2e runs AI_REPLAY=1 — ReplayProvider has offline=false but key "offline-stub"; detect the stub by key too
metadata:
  type: project
---

e2e runs with `AI_REPLAY=1` by default (`e2e/fixtures/ai-mode.ts`), which installs a `ReplayProvider` (`server/src/lib/ai/fixtures/install.ts`) with `offline = false` and `key: "offline-stub"`. Code that detects the stub only via `provider.offline === true` takes the wrong branch in e2e, and unit tests with hand-written fakes don't catch it (PR #900 / #713: the model picker listed only "Offline stub" and `model-selection.spec.ts` failed).

**Why:** the replay provider mimics the stub's identity but not its `offline` flag.

**How to apply:** treat `provider.offline === true || provider.key === "offline-stub"` as the stub, and add a replay-shaped fake to the route test.

**Text traps in e2e chat (#1428, #1454, 2026-10-23).**
- The offline stub's reply quotes the prompt, so `getByText(prompt)` in a chat transcript
  resolves to two elements. Match user messages with `{ exact: true }`.
- Text sent through `/api/ai/chat` must never carry a bare `Date.now()`: 13 digits that pass
  Luhn (about 1 in 10) are saved as `[REDACTED:CREDIT_CARD]` by
  `server/src/lib/safety/regex-blocklist.ts`. Use `Date.now().toString(36)`. An exact-text
  wait that fails, then passes on retry, with a timestamp in the text is probably the
  redactor: check the failure snapshot for `[REDACTED:`.
