---
name: client-address-behind-the-ui-proxy
description: Which client address the server sees behind the Next UI proxy, and why skip*Requests and decrement do nothing on the cluster rate-limit store (#1383 review, #1393).
metadata:
  type: project
---

**Why:** found routing traffic through the UI's Next proxy (#1383) and building the signed
client address and failures-only login cap (#1385/#1386, PR #1393).

**How to apply:**

- **Routing traffic through the UI's Next proxy changes the client IP the server sees.**
  `ui/src/lib/auth-proxy.ts` builds upstream headers from scratch, so IP-keyed limiters
  become one bucket per UI pod, and `/api/auth/oidc|saml/*` hit the UI catch-all 404.
- **Next 16 sets `X-Forwarded-For` with `??=`** (`base-server.js`), so a browser-sent value
  survives when the UI is the edge. Trust a forwarded address only with a proxy in front
  (`METIS_TRUSTED_PROXY_HOPS` >= 1; `server/src/middleware/auth-client-address.ts`).
- **`ClusterRateLimitStore.decrement` is a no-op** (`cluster-rate-limit-store.ts`), so
  `skipSuccessfulRequests` / `skipFailedRequests` silently do nothing on every cluster-store
  limiter.
- **Check, then record, with `RateLimitStore.count()`** (memory, Postgres and Valkey): it is
  the non-recording read. Count only reason `invalid_credentials` toward an account lockout,
  never an outage.

Related: [[preauth-limiters-keyed-on-req-ip]], [[csrf-boundary-is-the-ui-proxy]],
[[sso-login-identity-matching]].
