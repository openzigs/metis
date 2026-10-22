---
issue: 1312
section: Fixed
---

- Helm chart Ingress fixes:
  - It installs on a stock ingress-nginx, which rejected the old snippet annotation.
  - Browser logins work: `/api` goes to the UI, which sets the session cookie, and the UI is told where the server is (`METIS_API_URL`).
  - SSO endpoints (`/api/auth/oidc`, `/api/auth/saml`) still go to the server.
  - nginx accepts uploads up to the 50 MB cap.
  - In-cluster service URLs also work for releases not named `metis`.
