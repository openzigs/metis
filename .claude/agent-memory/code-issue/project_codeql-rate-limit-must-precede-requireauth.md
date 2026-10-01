---
name: codeql-rate-limit-must-precede-requireauth
description: CodeQL js/missing-rate-limiting counts requireAuth (JWT verify) as the authorization handler, so a limiter AFTER it does not satisfy the rule; put a module-scoped rateLimit() instance before requireAuth
metadata:
  type: project
---

CodeQL `js/missing-rate-limiting` flags a route whose chain is
`requireAuth, <perUserLimiter>, handler`: it treats `requireAuth` itself as the
"performs authorization" handler, and the per-user limiter placed after it does
not count. Eight such alerts on `routes/ai.ts` / `ai-conversation.ts` /
`ai-tool-approvals.ts` were dismissed as "false positive" before #291; on #291 the
user chose instead to add a generous per-IP limiter IN FRONT of `requireAuth`
(`conversationPreAuthRateLimiter`, `middleware/conversation-rate-limit.ts`).

**Why:** the per-user limiter keys on `req.user`, which exists only after auth, so
it cannot sit before it; an anonymous flood otherwise pays for a JWT verify each.

**How to apply:**
- A new authenticated route: chain `<ipLimiter>, requireAuth, …`. Export the
  limiter as the `rateLimit({...})` result itself at module scope (not wrapped in
  a closure) so CodeQL can see it; read `limit` per request from env so a test can
  lower it.
- Do not reuse `authRateLimiter` (20 / 15 min, credential stuffing) for app
  routes — every user behind one NAT shares an IP.
- Test determinism: `app.set("trust proxy", 1)` in the test app and a distinct
  `X-Forwarded-For` per test, or the shared store's counter leaks across tests.
- Related: `loadAuthorizedSession` re-checks project access on every session
  read; #304's hole was only at CREATE time — audit writers, not just readers.
- Refactors re-surface alerts (#628, #632): extracting `refreshAuthenticatedUser` into a helper made CodeQL treat it as an authorization step, so every router using it without a limiter got a NEW js/missing-rate-limiting alert (#536 duplicating #202) and the PR's CodeQL check went red on a file it never touched. Fix the router (add the limiter in its own PR, merge first, then update-branch); never dismiss the alert to turn CI green.
- A one-IP "falls back to IP" test passes even if the fallback key is a constant — send from a second IP that must still get 200 (#634).
