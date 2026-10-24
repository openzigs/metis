---
name: project-access-guard-wiring
description: Where requireProjectAccess goes on a route (per route, behind a pre-auth limiter), why a router can look unguarded and not be, and what the structural guard test cannot see. Hub for older route-wiring notes.
metadata:
  type: project
---

From PR #1344 (#960, project access on every Spec Kit route) and its review, 2026-10-21.

**Why:** the guard (`server/src/middleware/require-project-access.ts`) reads the database,
so where it sits decides both which tests pass and what CodeQL reports.

**How to apply:**

- **Put the guard on each route, not on the router.** In `server/src/routes/spec-kit.ts`, a
  router-level `r.use(requireAuth, requireProjectAccess())` failed six #953/#1059 tests: those
  routes need their pre-auth limiters to run BEFORE `requireAuth`, and a router-level `use`
  runs first.
- **A route with no limiter that gains the guard trips CodeQL `js/missing-rate-limiting`**
  (the guard is a DB read). Add a pre-auth limiter ahead of it in the same PR.
- **Check mount order before calling a route unguarded.** `server/src/routes/projects.ts`
  line 154, `r.use("/:id/:sub", requireAuth, requireProjectAccess("id"))`, already 404s every
  cross-workspace `/projects/<id>/<sub>/**` request. A sub-router mounted under it that lacks
  its own guard is a defence-in-depth gap, not a live hole; say which in the issue.
- **The structural test has a blind spot.** `server/tests/project-access-guard.test.ts`'s
  detectors (`guardPrecedesHandlers`, `guardOnEveryRoute`) see routes and nested Routers only;
  a plain `r.use(handler)` layer is invisible to them. Pair a structural "guarded" result with
  a behavioural cross-workspace request (expect 404) and a positive control (same request as a
  member succeeds).

**Later additions (2026-10-21/22).**
- CodeQL `js/missing-rate-limiting` does not recognise a limiter passed into a route through
  a function parameter, even in tests. Name the imported limiter directly in the route chain
  (#1362).
- Express 5 routes are case-insensitive and ignore a trailing slash, so middleware that gates
  on `req.path === "/x"` before the router is bypassed by `/x/` or `/X` while the handler
  still runs. Attach it to the route, or normalise the path (#1393 review).
- A new route needs its own limiter module: reusing a sibling's gives the wrong 429 wording
  (#1397 c3). The walkthrough-plan gate also applies; see
  [[publishing-guards-repo-identity-limiters]].
- Route-level helpers go in `lib/`, not `server/src/middleware/`: the unmounted-middleware
  test fails on any exported function there that no production module imports (#1393 c2).

**Folded here (retired from the index 2026-10-21; files unchanged):**

- [[permission-mock-hides-removed-gate]] — a pass-through `requirePermission` mock tests the
  handler, not its wiring; every new route needs a test that fails when its gate or limiter
  is removed (#454). CodeQL maps alerts by line in the merge ref: merge main before fixing one.
- [[object-acl-side-channels]] — owner-only routes leaked through the tool list, socket room,
  error text and a 409 (#349).
- [[unmounted-mw-ratchet]] — Unmounted-middleware ratchet: inline a limiter's handler; never
  export it (#1117).

Related: [[preauth-limiters-keyed-on-req-ip]], [[supertest-beforeall-peer-differs]],
[[product-repo-access-traps]], [[membership-access-widening-checklist]].

## Parent/child scoping (IDOR) — #1428 to #1448 (2026-10-23)

The `projects.ts` catch-all is now `r.use("/:id/:sub", requireAuth, requireProjectAccess("id"))`
at about line 157, and `requireProjectAccess` uses `assertLiveProjectAccess` (#1430).

- **A by-id helper under a nested route can ignore the parent.** `forgetEntry(entryId)` under
  `/projects/:id/chronicle/:entryId` deleted any project's entry (#1429, fixed). Child lookups
  must include the path's `projectId`.
- **Find-then-act.** Code often scopes the `findFirst` by parent but then acts by id alone
  (seen in `memory/chronicle.ts` and `finops-workspace.ts`). Bind the effect to the scoped
  lookup, or carry the parent key into the write.
- **State after #1433:** every route in `server/src/routes` naming a parent and child id
  scopes the child to its parent. The remaining IDOR risk is foreign ids in request BODIES
  (#1431, #1432). pr-reviews, project-scoped reviews and ast-cache rely on the catch-all and on
  `/projects` being mounted first in `index.ts`.
- **The catch-all masks a missing per-router guard in the full app.** Probe a new
  `/projects/:projectId/...` route on an unguarded router standalone, with a cross-workspace
  coordinator (#1448 review).
- **Cross-project 404 tests** on a projectScoped analysis route must use a second project in
  the caller's OWN workspace. A foreign-workspace project is refused earlier by
  `requireProjectAccess`, so the test passes even with `ensureAnalysisVisible` removed (#1436).
- **Limiter tests.** A limiter unit test with its own Express app does not prove the route
  uses the limiter. Drive the real router past a `*_LIMIT_MAX=1` cap with a fresh user per
  route (#1436).

## CodeQL `js/missing-rate-limiting` placement (#1472 to #1496, 2026-10-24)

- **A router-level `requireProjectAccess()`** (`r.use`) trips the alert unless the same
  `r.use` puts a `rateLimit()` limiter before `requireAuth` (shape:
  `server/src/middleware/baseline-scope-rate-limit.ts`, #1472).
- **Editing a handler body re-fires the alert on an existing route**, and a limiter after
  `requireAuth` (`aiRateLimiter`) does not count. A touched authz route needs a pre-auth
  limiter (`middleware/custom-agents-rate-limit.ts` reuses `runsPreAuthKey`, #1496).
- **A per-route limiter sharing a store class with a router-level one needs a distinct key
  prefix** (e.g. `rereview:`), or express-rate-limit logs `ERR_ERL_DOUBLE_COUNT` (see
  `middleware/runs-rate-limit.ts`, #1495).
- **Judge a CodeQL-driven limiter against the full mount order.** Routers mounted at
  `/projects/:projectId` in `server/src/routes/index.ts` (knowledgeRouter at about line 110,
  etc.) already run `requireAuth` + `requireProjectAccess` on every `/projects/:projectId/*`
  request (#1495 review).
- **A fix letting someone act without home-project access** must use the target-scoped
  compound key for the lookup, the exception must only narrow access, and check whether the
  resource then drops out of every list (unseeable, undoable state) (#1496 cycle 2).

Soft-deleted projects on background paths: [[deleted-project-background-firing-guard]].
