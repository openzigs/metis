---
issue: 308
section: Changed
---

- The server now runs on undici 8, and Node.js 22.19.0 is the new minimum (raised from 22.12.0, because undici 8 requires it). Every pinned, proxied and local-model HTTP connection keeps working on the new version. The dev compose server image now builds on Node 22.
