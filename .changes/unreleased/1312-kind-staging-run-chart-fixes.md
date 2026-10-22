---
issue: 1312
section: Fixed
---

- Helm chart: the nginx Ingress installs on a stock ingress-nginx, which rejected the old snippet annotation. Browser logins through the Ingress now work, because `/api` goes to the UI, which sets the session cookie, and the UI is told where the server is (`METIS_API_URL`). In-cluster service URLs also work for releases not named `metis`.
