---
name: test-harness-pitfalls-2026-11-14
description: Unit-harness traps - bare express vs createApp, vi.mock needs ...actual, prisma-mocked suites hit by new filters, startedAt ties, two-conjunct guards, call-site mutations (#2480-#2510).
metadata:
  type: project
---

- **Bare `express()` harness** (#2492): unit harnesses for top-level server routes skip `app.ts`'s global `cors()` and `csrfProtection`, so CORS/Origin/preflight pass in tests and fail in production. Probe through `createApp()` with supertest.
- **Rate limiter on tokens METIS did not sign** (#2492): the app-wide `apiRateLimiter` keys on the TCP peer (the ingress) there, so all callers share one bucket, and a spent bucket answers any JWT bearer with `requireAuth`'s 401, not 429. Such a route needs its own limiter.
- **Filter inside a library function** (#2491): breaks every unit suite that mocks `../prisma.js` and reaches it, often via a route import a grep for the function misses. Stub `restrictedIds` / `restrictedRequirementIds` and grep by route and module before trusting a local green.
- **`vi.mock` with an explicit export list** (#2494, truthy.test.ts): spread `...actual` before a new export is added, or importers of it break in that test.
- **startedAt ties** (#2507): a SQLite e2e test that hand-creates an AgentResult then runs a pass can tie on ms resolution, so `snapshot.agents.at(-1)` flakes. Pick by `agentKey`.
- **Two-conjunct guards** (#2510): mutate each conjunct separately; fixtures often satisfy the guard through the other.
- **Shared-helper mutation tables** (#2480): an access-control PR's mutation table usually mutates a shared helper, turning every call site red at once. Revert each call site separately (four one-line mutations there).
