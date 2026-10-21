---
name: codeql-csrf-query-heuristic
description: CodeQL js/missing-token-validation only recognises csurf/lusca/tiny-csrf or a compared csrf-named cookie/session property (#913).
metadata:
  type: project
---

CodeQL's `js/missing-token-validation` ("Missing CSRF middleware") cannot see a custom-header or Fetch-Metadata guard.

**Why:** `MissingCsrfMiddleware.ql` counts as protection only: a call to `csurf`, `tiny-csrf`, `lusca({csrf})`/`lusca.csrf`, `express.csrf`, Fastify `csrfProtection`; or a handler whose request flows to a `req.cookies|session|user` property named `*csrf*|*xsrf*` that is written, compared with `==`, or passed to a `check|verify|valid|equal` call; or one that sets a csrf-named cookie. The alert is reported at the FIRST `cookieParser()` (app.ts), not at the route.

**How to apply:**

- After #1347 merges, alert #24 (`app.ts` cookieParser) is a false positive: dismiss citing `docs/SECURITY.md` §2.5. Do not contort the guard to match the heuristic.
- A test-only express app with `cookieParser()` raises its own alert (#25): dismiss "used in tests".
