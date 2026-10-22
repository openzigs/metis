---
issue: 1378
section: Fixed
---

- `helm upgrade` no longer fails after an HPA has scaled a METIS Deployment.
  The chart no longer sets `replicas` on a Deployment whose HPA is enabled.
  Before, Helm 4 hit a server-side-apply conflict on `.spec.replicas`, and
  Helm 3 reset the replica count.
