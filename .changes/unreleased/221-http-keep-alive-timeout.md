---
issue: 221
section: Added
---

- `HTTP_KEEP_ALIVE_TIMEOUT_MS` sets how long the API server keeps an idle
  keep-alive connection open. Unset keeps Node's default (5 s). Behind a load
  balancer or proxy, set it above that proxy's idle timeout so the proxy never
  reuses a connection the server is closing. `0` means the server never closes
  an idle connection. The end-to-end test stack uses `0`; this fixes its
  intermittent `socket hang up` failures.
