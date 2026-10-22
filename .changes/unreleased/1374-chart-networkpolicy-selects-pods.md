---
issue: 1374
section: Security
---

- The Helm chart's NetworkPolicy now applies to the METIS pods. It selected a
  label that no pod carries, so it isolated nothing. Every pod is now
  default-deny except DNS. Each component gets only its own traffic, and only
  the server reaches outside the cluster.
- The server's outbound HTTPS is an `ipBlock` rule, so AI gateways and GitHub
  stay reachable. `networkPolicy.egress.extra` adds CIDR and port rules for
  LDAP, OIDC or SMTP, and Cilium scopes HTTPS to an FQDN allow-list.
