---
issue: 1374
section: Security
---

- The Helm chart's NetworkPolicies now select the METIS pods (they selected
  none). Each pod is default-deny except DNS, and only the server leaves the
  cluster: HTTPS as an `ipBlock`, plus `networkPolicy.egress.extra` rules.
- Set `networkPolicy.ingressCidrs` to the VPC CIDR for an ALB ingress (the
  render fails without it) and `databaseCidrs` or `databasePeers` for Postgres.
- `cilium.enabled=true` installs now enforce the FQDN allow-list on upgrade:
  add your LLM gateway, Jira and identity provider to `egress.extraFqdns`.
