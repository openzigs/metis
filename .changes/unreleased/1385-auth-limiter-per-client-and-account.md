---
issue: 1385
section: Security
---

- Behind a reverse proxy (the Helm Ingress), the `/api/auth/*` limiter counts per client, not per
  UI pod: the UI signs the client address with `METIS_UI_PROXY_SECRET`, and the server trusts it
  only with a valid signature, else the TCP peer, never `X-Forwarded-For`. Docker Compose, where
  the UI is the edge, stays one bucket per UI container unless a proxy fronts it.
- A per-account cap (`AUTH_ACCOUNT_RATE_LIMIT_MAX`, default 10 / 15 min) limits refused
  passwords per username; successful sign-ins and directory outages are not counted.
