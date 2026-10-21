---
name: csrf-boundary-is-the-ui-proxy
description: The browser's CSRF boundary is the Next /api proxy (it turns metis.at into a Bearer token), not the Express API (#913, PR #1347).
metadata:
  type: project
---

A CSRF check on the Express API alone protects no browser user.

**Why:** the browser holds its session as `metis.at`/`metis.rt` on the UI origin. `ui/src/app/api/[...path]/route.ts` turns `metis.at` into `Authorization: Bearer`, so a forged write that reaches the proxy arrives at the API with a valid bearer token, and bearer requests are not CSRF-gated. The API's `accessToken` cookie path is reached only by the UI server's own calls (`auth-proxy.ts`, `edge-auth.ts` refresh) and SSO.

**How to apply:**

- Browser-facing cross-origin checks go in `ui/src/lib/csrf-guard.ts` (Sec-Fetch-Site, else Origin vs Host/X-Forwarded-Host; Go `CrossOriginProtection` algorithm). Apply it in every Next route handler that forwards a write.
- The API guard (`server/src/middleware/csrf-protection.ts`) requires `X-METIS-CSRF` on cookie-authenticated writes; any new server-side caller that sends the session cookie upstream must send it.
- `/api/auth/saml/acs` must be on the API origin; the UI proxy answers 404 `SAML_ACS_WRONG_ORIGIN`.
