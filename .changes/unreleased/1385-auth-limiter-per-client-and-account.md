---
issue: 1385
section: Security
---

- The `/api/auth/*` limiter no longer treats every user behind a UI pod as one client: the UI
  signs the client address with `METIS_UI_PROXY_SECRET`, and the server keys on it only when the
  signature verifies, otherwise on the TCP peer, never on `X-Forwarded-For`. A new per-account
  cap (`AUTH_ACCOUNT_RATE_LIMIT_MAX`, default 10 / 15 min) limits login attempts per username.
