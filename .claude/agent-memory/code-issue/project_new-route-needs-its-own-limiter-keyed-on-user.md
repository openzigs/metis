---
name: new-route-needs-its-own-limiter-keyed-on-user
description: A new Express route fails the CodeQL check (js/missing-rate-limiting) unless it carries its own limiter; there is no global one. Key it on the authenticated user, never req.ip; the CodeQL check lands after Analyze javascript-typescript
metadata:
  type: project
---

A new Express route trips CodeQL `js/missing-rate-limiting` as a FAILING check
unless it carries its own limiter: there is no global limiter in
`server/src/app.ts`, and a router mounted without one (`/runs`, `routes/index.ts`)
makes every route on it an alert. PR #1112 added `GET /api/runs/chat-turns` and
went red on alert 562; the sibling `GET /api/runs` had carried the same alert
(520) on main unnoticed.

The `CodeQL` check lands LATER than `Analyze javascript-typescript`: the analysis
job goes green first and the alert-diff check follows. Read `gh pr checks` after
`CodeQL` itself has completed, not when `Analyze` passes. CodeQL cannot be run
locally.

**Key authenticated routes' limits on the user, not `req.ip`.** Under the default
`trust proxy = 1`, `req.ip` is the last `X-Forwarded-For` entry, which is
client-controlled when the Next UI server is the edge (#1105, #1109). A budget
keyed on it can be dodged and can be spent on someone else's behalf.

**How to apply** (the arrangement in `middleware/runs-rate-limit.ts`, #1007):
- `<preAuthLimiter>, requireAuth, <userLimiter>, requirePermission(...)`, written
  inline on each route, each limiter the module-scoped `rateLimit()` result.
- The user limiter keys on `req.user.userId`, with the TCP peer
  (`req.socket.remoteAddress`) as the fallback for a mis-wired route.
- The pre-auth guard exists because CodeQL counts only a limiter ahead of the
  authorization step. Its key must not be a value the caller chooses: the
  rate-limit store keeps every key until its window ends, so keying on a digest
  of the PRESENTED token (as `spec-kit-job-rate-limit.ts` does) lets a caller
  mint a counter per request. Key on the user id inside a token this server
  signed (`signedAccessTokenUserId`: signature check, expiry ignored so an
  expired token still reaches its 401 `TOKEN_EXPIRED`), else on the TCP peer.
- Tests: the limiters are module-level, so give each test its own user; prove
  order with "anonymous requests get 401, not 429, at user cap 1" and that a
  varying `X-Forwarded-For` does not dodge the cap.
- See also `project_codeql-rate-limit-must-precede-requireauth.md` (the older
  per-IP form of the pre-auth guard).
