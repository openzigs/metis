---
issue: 1349
section: Security
---

- The realtime (socket.io) connection refuses a cookie-authenticated handshake from an origin that is not the UI (`CORS_ORIGIN`), `METIS_TRUSTED_ORIGINS` or the API itself, closing cross-site WebSocket hijacking from a sibling subdomain. Token-authenticated clients are unaffected.
- Upgrade note: if the UI is served from a different origin than the API and `CORS_ORIGIN` does not name it, live updates stop after upgrading (the handshake is refused `ORIGIN_REJECTED`). Set `CORS_ORIGIN` (or `METIS_TRUSTED_ORIGINS`) to the UI's public origin; the API logs the accepted list at startup.
- The traceability and analysis-approval pre-auth rate limiters no longer key on the client-writable `X-Forwarded-For`.
