---
name: project_e2e-replay-provider-not-offline
description: e2e runs AI_REPLAY=1 — ReplayProvider has offline=false but key "offline-stub"; detect the stub by key too
metadata:
  type: project
---

e2e runs with `AI_REPLAY=1` by default (`e2e/fixtures/ai-mode.ts`), which installs a `ReplayProvider` (`server/src/lib/ai/fixtures/install.ts`) with `offline = false` and `key: "offline-stub"`. Code that detects the stub only via `provider.offline === true` takes the wrong branch in e2e, and unit tests with hand-written fakes don't catch it (PR #900 / #713: the model picker listed only "Offline stub" and `model-selection.spec.ts` failed).

**Why:** the replay provider mimics the stub's identity but not its `offline` flag.

**How to apply:** treat `provider.offline === true || provider.key === "offline-stub"` as the stub, and add a replay-shaped fake to the route test.
