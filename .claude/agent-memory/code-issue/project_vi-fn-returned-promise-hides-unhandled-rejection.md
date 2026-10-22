---
name: vi-fn-returned-promise-hides-unhandled-rejection
description: A rejected promise returned through a vi.fn is never unhandled, because vitest attaches its own .then to record settled results; a "rejection is swallowed" test through one cannot fail.
metadata:
  type: project
---

On #1414, `ui/tests/socket-status.test.tsx` tested that `socket-client.ts` swallows a
rejected `refreshAccessToken()` (`void refreshAccessToken().catch(() => undefined)`).
The test mocked the refresh with `vi.fn().mockRejectedValue(...)`. With the `.catch`
deleted, the test still passed, and vitest reported no unhandled rejection. A second
attempt failed the same way: it spied on the promise's `.then` to see whether a rejection
handler was attached.

**Why:** vitest's `vi.fn` records `mock.settledResults`, so it calls `.then(onFulfilled,
onRejected)` on every promise a mock returns. That attaches a rejection handler before the
code under test runs. The rejection is then always handled, and any "was a handler
attached" probe always reads true. The adversarial panel's test-falsifiability lens caught it.

**How to apply:** when a test must prove that code handles a rejection, return the
rejected promise from a plain function rather than through the `vi.fn`. Keep the `vi.fn`
only to count calls. Create the rejected promise lazily, inside the call, so it does not sit
unhandled while the test awaits setup. Then check the test by deleting the `.catch`.
