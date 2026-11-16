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
- **Fail-closed catch + partial Prisma mock** (#2517 fixer): a gate written `mayRestOnRestrictedRead(...).catch(() => true)` turns a missing method in an unrelated suite's Prisma mock into a behaviour change that fails only in CI. Search for suites mocking `prisma.analysis` without `findUnique`.
- **Route gates and roles** (#2518 panel): every built-in role holds `review.read`, so a route gate on it cannot be tested by switching roles. (#2559) `requirePermission` checks the role table (`hasPermission(role, …)`), not the token's permissions claim, and only admins hold `document.delete`; to test an access-list guard on an admin-only route with real Alice/Bob, partially mock `@metis/shared`'s `hasPermission`.
- **Unreachable escapes** (#2557): on an "admin is never refused" escape, check whether an earlier guard already refuses everyone in that case; a mutation test showed the reviewer-assignment escape could never run.
- **Same-404 guards** (#2584): a guard in front of a later check returning the same 404 cannot be proven by an outsider test. Use a caller who passes the later check and assert the error code.
- **Scorer fixtures** (#2561 review): eval fixtures often set the repo verdict and criteria to the same value, hiding `criteria.includes(X)` -> `verdict === X` mutations. Test them separately.
- **TanStack mutate is async** (#2579): `mutate` runs `mutationFn` after the click returns, so a "no call sent" assertion must wait a tick first.
- **Ticking text in role=status** (#2582): per-second text inside `role=status` announces every second. Keep the ticking part outside the region and test `getByRole('status')` text before and after a fake-timer advance.
- **Shared-helper mutation tables** (#2480): an access-control PR's mutation table usually mutates a shared helper, turning every call site red at once. Revert each call site separately (four one-line mutations there).
