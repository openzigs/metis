---
issue: 1377
section: Fixed
---

- Live updates connect behind an ingress. The release UI image dialled Socket.IO at
  `http://localhost:4000` from every host, because that URL was baked in at build
  time. The browser now dials its own origin by default; `METIS_BROWSER_SOCKET_URL`
  on the UI overrides it at runtime (Docker Compose sets `http://localhost:4000`).
