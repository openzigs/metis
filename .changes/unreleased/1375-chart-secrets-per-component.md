---
issue: 1375
section: Security
---

- The Helm chart no longer gives every secret to every pod. The UI gets none,
  each sidecar gets only its own token, and the server gets the rest. Routing
  is set per component in `secrets.components`.
- The UI and both sidecars now run as a separate ServiceAccount that has no
  IRSA role, no RBAC and no mounted token. Before this, they ran as the
  server's account.
