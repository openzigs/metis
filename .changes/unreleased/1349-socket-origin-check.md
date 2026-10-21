---
issue: 1349
section: Security
---

- The realtime (socket.io) connection refuses a cookie-authenticated handshake from an origin that is not the UI (`CORS_ORIGIN`), `METIS_TRUSTED_ORIGINS` or the API itself, closing cross-site WebSocket hijacking from a sibling subdomain. Token-authenticated clients are unaffected.
- The traceability and analysis-approval pre-auth rate limiters no longer key on the client-writable `X-Forwarded-For`.
