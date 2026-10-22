---
name: helm-chart-install-and-networkpolicy-traps
description: Traps installing and testing the deploy/helm/metis chart (kind, Helm 4 tpl, health paths, required values) and in NetworkPolicy changes that start selecting pods (#1372, #1383, #1387, #1393).
metadata:
  type: project
---

Chart: `deploy/helm/metis/`. Render tests: `deploy/helm/metis/tests/render-tests.sh`. Live
smoke: `scripts/kind-smoke.sh`.

**Why:** each bullet cost a red run or a wrong claim while bringing the chart up on kind and
Docker Desktop (2026-10-21/22).

**How to apply:**

**Installing and checking it (#1383).**
- A production install crash-loops without `server.env.AUTH_MODE`. The UI also needs
  `METIS_API_URL` and `/api` routed to the UI, and login needs HTTPS (the session cookies
  are `Secure`).
- Through the chart Ingress, check health at `/api/health`: `/healthz` and `/readyz` hit the
  UI and redirect to `/login`. The server image has no `curl`; in-pod checks use
  `node -e "fetch(...)"`.
- Under Helm 4 the chart's `server.env` values go through `tpl`, so a literal `{{` (the LDAP
  filter `(uid={{username}})`) must be escaped. `helm upgrade` after an HPA has scaled needs
  `--force-conflicts` until #1378.
- On a 4 GB Docker host the server image build OOMs in `tsc` unless the builder stage sets
  `NODE_OPTIONS=--max-old-space-size=3072` (a local workaround; the repo does not set it).
- kind v0.31 on Docker Desktop does not enforce NetworkPolicy egress, even with
  kube-network-policies. NetworkPolicy tests need Calico or Cilium.

**Asserting renders (#1387).** Parse renders the way `render-tests.sh` does (`ruby -ryaml
-rjson` into `jq`: `render_json`, `jqr`, `egress_for`), never with `grep`: a grep for
`replicas: 2` passed while matching the wrong Deployment.

**Secrets per component (#1393).** Since #1387's `secrets.components`, a new secret the UI
needs must be added to `components.ui` and asserted in `kind-smoke.sh` / `render-tests.sh`
in the same change, or kind-smoke goes red.

**A NetworkPolicy that starts selecting pods (#1387 review, c2).**
- Every ingress source is enforced for the first time. ALB `target-type: ip` traffic comes
  from VPC ENIs and needs an `ipBlock`. A newly live CiliumNetworkPolicy's FQDN list must
  cover the providers in `server/src/lib/ai/providers/` plus AWS STS, S3 and Secrets Manager.
- `ipBlock.except` must lie inside its `cidr` or the API server rejects the policy. Put
  cluster-CIDR excepts only on `0.0.0.0/0` and `::/0` of the same family (the
  `metis.netpolIpBlock` helper in `templates/_helpers.tpl`).

**"Process-local" state behind a polled GET (#1372 review).** With more than one replica it
flips between values on every poll. The chart gives sticky routing only for
`ingress.className: alb` (`stickiness.lb_cookie` in `templates/ingress.yaml`); nginx and
traefik round-robin. Check any "process-local is fine" claim against that template and the
UI's `refetchInterval`.

Related: [[client-address-behind-the-ui-proxy]], [[image-scan-trivy-and-digest-pins]].
