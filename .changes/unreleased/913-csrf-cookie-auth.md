---
issue: 913
section: Security
---

- State-changing requests are refused when they come from another origin. The UI's
  API proxy checks `Sec-Fetch-Site`/`Origin` before turning the session cookie into
  a bearer token, and the API refuses a cookie-authenticated write that lacks the
  `X-METIS-CSRF` header. Bearer-token clients, webhooks and the SAML sign-in are
  unaffected; set `METIS_TRUSTED_ORIGINS` if the UI is served under another origin.
