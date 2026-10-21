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
