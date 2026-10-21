---
name: unmounted-mw-ratchet
description: unmounted-middleware.test.ts flags a NON-exported (req,res,next) function as the preceding export of the file; inline the handler into the mounted limiter's config instead
metadata:
  type: project
---

`server/tests/unmounted-middleware.test.ts` (#1083) fails when an exported
handler-shaped symbol in `server/src/middleware/*.ts` has no production importer.
Two traps, both hit on #1117:

1. Exporting a limiter's custom `handler` (to unit-test it) fails the ratchet: the
   only importer is the colocated test, which does not count.
2. Un-exporting it is not enough when it is a top-level function: the detector
   attributes a handler signature to the export that precedes it in the file, so it
   then flagged the unrelated `runsWriteUserKey` (a key function) instead.

**Why:** the detector reads export blocks textually, not by symbol scope.

**How to apply:** put a custom express-rate-limit `handler` inline in the
`rateLimit({...})` config of the exported, mounted limiter, and test it through the
limiter (`express()` + supertest with the cap env set to 1), as
`runs-rate-limit.test.ts` does. Never append to `UNMOUNTED_MIDDLEWARE_BASELINE`.
