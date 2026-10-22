# Kubernetes production-readiness checklist

> Walk this list before promoting any METIS install to production traffic. Every item has a `kubectl` (or `aws`) one-liner so the audit can be automated. Items are grouped by acceptance gate.
>
> **Last walked end to end:** #1312 (2026-10-21), on a three-node kind cluster with images built from `main`. The results table and the issues it filed (#1374–#1381) are on that issue. Cloud-only items (IRSA, ALB/ACM, EBS snapshots, cross-AZ reschedule) are still open there.

## 0. Before you install

The chart leaves three server settings to you, and the install does not work without them. See the chart README, § "Server env the chart does not set for you".

- [ ] `server.env.AUTH_MODE` is `ldap`, `oidc` or `saml`. If it is unset, the server resolves to mock auth and **refuses to start** under `NODE_ENV=production` (CrashLoopBackOff).  
  `kubectl logs -n metis deploy/metis-server | grep -c "Refusing to start with mock auth"` should return `0`.
- [ ] `server.env.CORS_ORIGIN` is `https://<ingress host>`. If not, every browser socket is refused with `ORIGIN_REJECTED` (#1349).
- [ ] `server.env.MCP_RUNTIME` is `k8s-sse` (see §15).
- [ ] On OIDC or SAML, the provider comes from `AUTH_OIDC_*` / `AUTH_SAML_*` in `server.env` (secret parts through `secrets.keyMap`). On boot, the server logs `SSO providers configured from the environment: oidc` (or `saml`). A provider saved only through the admin API is lost when the pod restarts (#1376).
- [ ] A first admin exists: `server.env.METIS_BOOTSTRAP_ADMINS` names the administrator's username or e-mail, and that person has signed in once (#1376). After that, their `/api/auth/me` reports `role: admin`. Once an admin exists the variable does nothing.

---

## 1. Probes

- [ ] **Liveness probe** configured on every container.  
  `kubectl get deploy -n metis -o jsonpath='{range .items[*]}{.metadata.name}{":"}{.spec.template.spec.containers[*].livenessProbe}{"\n"}{end}'`
- [ ] **Readiness probe** configured on every container.  
  `kubectl get deploy -n metis -o jsonpath='{range .items[*]}{.metadata.name}{":"}{.spec.template.spec.containers[*].readinessProbe}{"\n"}{end}'`
- [ ] **Startup probe** on the embeddings pod (cold-start can exceed `initialDelaySeconds`).  
  `kubectl get deploy/metis-embeddings -n metis -o jsonpath='{.spec.template.spec.containers[0].startupProbe}'`

## 2. Resources

- [ ] Every container has both `resources.requests` and `resources.limits`.  
  `kubectl get pods -n metis -o jsonpath='{range .items[*].spec.containers[*]}{.name}{":"}{.resources}{"\n"}{end}'`
- [ ] Memory `limits` mirror or exceed `docker-compose.prod.yml`: server 1024Mi, embeddings 1536Mi, ui 512Mi.

## 3. PodDisruptionBudgets

- [ ] PDB present for every Deployment that can absorb a drain.  
  `kubectl get pdb -n metis`
- [ ] `ui`, `server` and `embeddings` each have `minAvailable: 1`. A budget is rendered only when the component's replica floor exceeds it, so a single-replica `server` gets **no** PDB: a drain causes a brief outage, which is accepted. `minAvailable: 1` over one replica would make the node undrainable.

## 4. Autoscaling

- [ ] HPA on `ui`, which needs metrics-server.  
  `kubectl get hpa -n metis`
- [ ] The `server` HPA is enabled by default (2→6). Keep it on only with the shared backends (Postgres, pgvector, S3, leader election; `values-prod.yaml`). On the single-replica SQLite/LanceDB profile, set `autoscaling.server.enabled=false` and `server.replicaCount=1`.
- [ ] A Deployment with an enabled HPA renders no `replicas` (#1378), so `helm upgrade` after the HPA has scaled succeeds without `--force-conflicts` and keeps the HPA's count. Check that `helm get manifest metis -n metis` shows no `replicas:` on `metis-ui` or `metis-server`. On the first upgrade from a chart that still set `replicas`, Helm 3 drops the count to 1 until the HPA scales back to `minReplicas`. Helm 4 keeps the count of a Deployment the HPA has already scaled. With Helm 3, upgrade outside peak hours, or scale up again right after.

## 5. NetworkPolicy

- [ ] **Default-deny ingress + default-deny egress** for every METIS pod: `metis-default-deny`, plus `metis-ui`, `metis-server` and `metis-sidecars` granting each component its traffic (chart README, "HPA / PDB / NetworkPolicy").  
  `kubectl get networkpolicy -n metis`
- [ ] Only the server has external egress: HTTPS (`networkPolicy.egress.https`), the Kubernetes API, the database (`networkPolicy.egress.databaseCidrs`, **required** with Postgres: empty, the server cannot reach RDS) and `networkPolicy.egress.extra` (LDAP, OIDC on a non-443 port, SMTP). With Cilium, HTTPS is scoped to the AI gateway and GitHub FQDNs instead.
- [ ] With an ALB ingress, `networkPolicy.ingressCidrs` holds the VPC CIDR: the ALB reaches and health-checks the pods from VPC ENIs, which no namespace selector matches. The chart refuses to render an ALB install without it; check that the value is your VPC's, not the `values-prod.yaml` default.  
  `aws ec2 describe-vpcs --vpc-ids <vpc> --query 'Vpcs[0].CidrBlock'`
- [ ] With Cilium as the CNI, `networkPolicy.cilium.enabled=true`, and every host the server calls is in the FQDN allow-list (`extraFqdns`: LLM gateway, Jira, GitHub Enterprise, OIDC IdP). Anything not listed is blocked.
- [ ] The policy actually selects the METIS pods. The command below must list every pod (#1374).  
  `kubectl get pods -n metis -l "$(kubectl get networkpolicy -n metis metis-default-deny -o jsonpath='{.spec.podSelector.matchLabels}' | jq -r 'to_entries|map("\(.key)=\(.value)")|join(",")')"`
- [ ] Verified with a smoke test **from the server pod itself**. A bare `kubectl run … curlimages/curl` proves nothing: PSA `restricted` rejects it, and without the chart's labels the policy would never select it. With `networkPolicy.egress.https.cidrs` narrowed (or Cilium FQDNs on), expect a host outside the allow-list to fail, `https://api.github.com` to answer, and the embeddings sidecar to answer. With the default `0.0.0.0/0`, every HTTPS host answers:  
  `kubectl exec -n metis deploy/metis-server -- node -e "fetch('https://example.com',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('REACHED',r.status)).catch(e=>console.log('BLOCKED',e.cause?.code||e.name))"`  
  `kubectl exec -n metis deploy/metis-server -- node -e "fetch(process.env.EMBEDDINGS_URL+'/healthz').then(r=>console.log(r.status))"`  
  Run this on a CNI that enforces egress policy (Calico, Cilium). The kindnet in a Docker Desktop kind cluster did not enforce it in #1312, even with `kube-network-policies` installed: a pod under an egress deny-all policy still reached `https://1.1.1.1`.
- [ ] FQDN-aware policies via Cilium when AI gateway egress must be hostname-scoped (`networkPolicy.cilium.enabled=true`).

## 6. RBAC

- [ ] Server SA does **not** have cluster-admin.  
  `kubectl auth can-i '*' '*' --as=system:serviceaccount:metis:metis-server` should return `no`.
- [ ] Server SA can manage Deployments/Services/NetworkPolicies in `metis-mcp` only.  
  `kubectl auth can-i create deployments --as=system:serviceaccount:metis:metis-server -n metis-mcp` should return `yes`.
- [ ] No `*` verbs / `*` resources / `*` apiGroups in the server's Role.  
  `kubectl get role/metis-mcp-provisioner -n metis-mcp -o yaml`

## 7. IRSA

- [ ] METIS server SA annotated with a role ARN scoped to `metis/*` Secrets Manager ARNs.  
  `kubectl get sa metis-server -n metis -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}'`
- [ ] IAM policy attached to the role contains **only** `secretsmanager:GetSecretValue` + `DescribeSecret` on `arn:aws:secretsmanager:*:*:secret:metis/*`.

## 8. Secrets

- [ ] Secret `metis-secrets` exists and contains all required keys.  
  `kubectl get secret metis-secrets -n metis -o jsonpath='{.data}' | jq 'keys'`  
  Expected: `JWT_SECRET, VAULT_MASTER_KEY, EMBEDDINGS_TOKEN, SQL_LINEAGE_TOKEN, DATABASE_URL, OPENAI_API_KEY, GITHUB_TOKEN, METRICS_TOKEN, METIS_UI_PROXY_SECRET`, plus `AUTH_LDAP_BIND_PASSWORD` (added to `secrets.keyMap`) when `AUTH_MODE=ldap`.  
  On the SQLite profile, set `DATABASE_URL` to `file:/app/server/data/metis.db` or leave the key out. An empty value still overrides the image's default.
- [ ] When using ESO, the `ExternalSecret` reports `SecretSyncedError: false`.  
  `kubectl get externalsecret metis-secrets -n metis -o jsonpath='{.status.conditions}'`
- [ ] No plaintext secret values committed to Git.
- [ ] Only the server receives the vault key, JWT secret and provider tokens (`secrets.components`, #1375). The UI references only `METIS_UI_PROXY_SECRET` (#1385), and each sidecar only its own token:  
  `kubectl get deploy metis-ui -n metis -o yaml | grep -cE 'VAULT_MASTER_KEY|JWT_SECRET'` should return `0`, and its one `secretKeyRef` is `METIS_UI_PROXY_SECRET`.  
  `kubectl get deploy metis-embeddings metis-sql-lineage -n metis -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.template.spec.containers[0].env[*].valueFrom.secretKeyRef.key}{"\n"}{end}'` should print one token each.
- [ ] The UI and sidecars run as `metis-workload`, which has no IRSA role and mounts no token:  
  `kubectl get deploy metis-ui -n metis -o jsonpath='{.spec.template.spec.serviceAccountName} {.spec.template.spec.automountServiceAccountToken}'` should print `metis-workload false`.

## 9. Image hygiene

- [ ] All four images (`metis-server`, `metis-ui`, `metis-embeddings-svc`, `metis-sql-lineage`) are published for the tag by `build-images.yml` (#1382; `image-build-wiring.test.mjs` fails if the chart names an image the matrix does not publish).
- [ ] All four images scanned with Trivy (or ECR scan-on-push): **fixable** High/Critical = 0, and every unfixed one recorded.  
  `trivy image --scanners vuln --severity HIGH,CRITICAL ghcr.io/openzigs/metis-server:<tag>`  
  The policy (#1379), enforced by `scripts/lib/image-scan-gate.mjs` in ci.yml's `api` job on every image-touching PR, on `main` and nightly, and in `build-images.yml` before a tag publishes:
  - **Fails:** any HIGH or CRITICAL that has a fixed version. Fix it by rebuilding: the images apply distro security updates at build time, and the bases are pinned by digest. Or upgrade the package, or remove it from the runtime image.
  - **Fails:** an unfixed CRITICAL that is not recorded in `.github/image-scan-waivers.json`.
  - **Fails:** a recorded finding past its `expires` review date.
  - **Fails:** a finding whose waiver was removed. A waiver leaves `waivers` only by moving to the file's `expired` section, and any finding matching an `expired` id fails. On a pull request, deleting a waiver from `waivers` without moving it also fails while its finding is present (the scan reads the base branch's file). Deleting the record therefore never turns a red build green; only a fix does, or a deliberate re-dating.
  - **Fails:** a scan that cannot be trusted. That means a report with no detected OS family, no `os-pkgs` result, or an end-of-life distro release. In those cases Trivy skips the OS packages and exits 0, so "no findings" would only mean "not looked".
  - **Warns:** an unfixed HIGH that is not recorded yet. Record it with a reason and a review date.
  - Findings go to code scanning as SARIF on `main`, nightly and release. Results that a live waiver covers are filtered out first, so the Security tab shows only what still needs action.
  - The Trivy vulnerability DB is cached per day. The download is retried, and if it still fails, the scan falls back to an earlier cached DB with a warning. The step fails only if no DB exists at all.

  **Release scanning (`build-images.yml`).** Every image is scanned on **both** amd64 and arm64. Each architecture builds natively on its own runner (`ubuntu-24.04-arm` for arm64), as the published variant: the default `BAKE_MODELS=1` and the run's single `OS_PATCH_DATE`. The publish job needs every scan leg, so one image failing its gate publishes **none** of the four.

  Residual gap: the publish step rebuilds the image rather than pushing the scanned bytes. With digest-pinned bases and one patch date, the package set matches, unless the distro mirror published an update between the two builds.

  **What Trivy does not see: the Node.js and CPython runtimes.** The official `node` and `python` images install the runtime outside the distro's package manager, so `apt-get upgrade` / `apk upgrade` never patch it and Trivy does not report its CVEs. Measured on 2026-10-21 with Trivy 0.71.1: `node:22.1.0-alpine` (April 2024, many Node security releases behind) reported no finding for `node`, and `python:3.12.0-slim` reported none for CPython (only `setuptools` and `wheel`). Runtime fixes therefore arrive **only** through base-image digest bumps:
  - **Cadence:** Dependabot's `docker` ecosystem opens one grouped PR a week for every Dockerfile directory, after the repository's 7-day cooldown. ci.yml builds and scans those `dependabot/docker/*` branches like any other image change.
  - **Out of band:** when nodejs.org or python.org announces a security release that affects the runtime line in use (Node 22, Python 3.12), bump the digests by hand that week: `docker buildx imagetools inspect <tag>`, then replace the digest in every `FROM`. Do not wait for the cooldown.

  #1312 measured server 58 HIGH/0 CRITICAL, ui 26/1, embeddings 92/7 and sql-lineage 61/3. After #1379 the counts were server 43/0, ui 0/0, embeddings 43/0 and sql-lineage 44/0, with none fixable. What remains is 8 Debian trixie CVEs with no fix (util-linux, ncurses, systemd, acl, perl-base), recorded with a 2027-01-19 review date.
- [ ] **Recommended**: Cosign signatures on tagged images.  
  `cosign verify ghcr.io/openzigs/metis-server:<tag>`
- [ ] Multi-arch manifest present (amd64 + arm64) — required for Graviton nodes.  
  `docker buildx imagetools inspect ghcr.io/openzigs/metis-server:<tag>`

## 10. Pod security

- [ ] Namespace labelled `pod-security.kubernetes.io/enforce: restricted`.  
  `kubectl get ns metis -o jsonpath='{.metadata.labels}'`
- [ ] Containers run as non-root (UID 1001), `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`, `seccompProfile.type: RuntimeDefault`.  
  `kubectl get pods -n metis -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.spec.containers[*].securityContext}{"\n"}{end}'`

## 11. Observability

- [ ] ServiceMonitor (or static Prometheus scrape) configured for the `/metrics` endpoint, gated by `METRICS_TOKEN`.
- [ ] Log-shipper (Vector / Fluent Bit DaemonSet / CloudWatch Container Insights) capturing pod stdout.

## 12. Persistence

- [ ] PVCs reclaim policy = `Retain` (`Retain` on the StorageClass + `helm.sh/resource-policy: keep` on the PVC).  
  `kubectl get pvc -n metis -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.metadata.annotations.helm\.sh/resource-policy}{"\n"}{end}'`
- [ ] Repository clones on a persistent volume (#1322). The chart sets `REPO_CLONE_DIR=/app/server/data/repo-clones`, on the server's **data** volume (`persistence.data`, PVC `<release>-server-data`), never `/tmp`.  
  `kubectl exec deploy/metis-server -n metis -- printenv REPO_CLONE_DIR`  
  With `persistence.data.enabled=false` (`values-prod.yaml`, multi-replica) that directory is an emptyDir: a pod that finds a clone missing re-fetches it at the code graph's commit before generating a document (egress to the git host required), or stops the run before any AI spend and asks for a re-ingest.  
  **Cost of that profile:** every pod keeps its own clone, so each repository is fetched once per pod after every pod start (a depth-1 fetch of one commit, capped by `REPO_CLONE_MAX_BYTES`), and the first document or analysis on a fresh pod waits for it. Ingest runs on one pod, so the other pods' first use is a re-fetch, not a copy.  
  **To share one clone across pods instead:** `persistence.efs.enabled=true` with `persistence.data.enabled=true` puts the data volume (and so the clones) on an RWX EFS claim every replica mounts. A pod that meets a clone another job is preparing waits up to `CLONE_RESTORE_LEASE_WAIT_MS` (default 120000) and then stops with *"try again in a few minutes"*, never a re-ingest request. The wait is per pod (an in-process lease), so on a shared volume two pods can still restore the same clone at once; each builds in its own `.restore-*` directory and renames it into place, and staging left by a dead pod is swept after an hour.
- [ ] Backup policy in place — Velero schedule **or** EBS snapshot lifecycle policy on the volumes.
- [ ] Restore tested — at least one successful PVC restore drill on a side environment. For the SQLite/PVC profile, the backup Job and the restore pod are in the chart README, § "Backup and restore". Both were drilled in #1312.

## 13. Drain test

- [ ] `kubectl cordon <node>` followed by `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data` completes within `terminationGracePeriodSeconds`.
- [ ] `metis-server` rolls onto a different node and reaches `Ready` without the LanceDB volume needing manual rescue. On the RWO-PVC profile this needs another node in the **same AZ**, because an EBS volume cannot attach across AZs. Otherwise the pod stays `Pending` ("didn't match PersistentVolume's node affinity") until a node in that AZ is schedulable. In #1312 the node-local PVs of kind showed exactly that. The server stayed `Pending` until uncordon and was `Ready` 12 s afterwards, with its data intact.

## 14. Ingress + TLS

- [ ] Ingress reaches `Ready` and resolves to a real ALB / nginx LB FQDN.
- [ ] TLS termination works: `curl -v https://<host>/api/health` shows a valid cert chain and `{"status":"ok"}`. Use `/api/health`, because the ingress sends `/healthz` to the UI, which redirects to `/login`.
- [ ] Login sets the session cookies (`metis.at`, `metis.rt`, both `Secure; HttpOnly`). This works only over HTTPS, and only because `/api` routes to the UI (#1312).
- [ ] The login limiter counts per client, not per UI pod (#1385): with `METIS_UI_PROXY_SECRET` set, 21 failed logins (each with a different username) from one machine end in `429`, and a login from a second machine (another address) still gets `401`, not `429`.
- [ ] With SSO: `/api/auth/oidc` and `/api/auth/saml` route to the **server**, not the UI. The UI 404s `/api/auth/*`. The IdP is registered on the public origin: OIDC redirect URI `https://<host>/api/auth/oidc/callback`, SAML ACS `https://<host>/api/auth/saml/acs`. Run one SSO login round-trip end to end: it lands on `https://<host>/dashboard` signed in, with `metis.at` and `metis.rt` set `Secure; HttpOnly` (#1386).  
  `curl -s https://<host>/api/auth/saml/metadata` should return SP metadata XML, or the server's `SSO_NOT_CONFIGURED` when SAML is not set up. The UI's `NOT_FOUND` / `SAML_ACS_WRONG_ORIGIN` means the route goes to the wrong backend.
- [ ] Uploads near the cap pass the Ingress: on nginx, `proxy-body-size` is `50m` (`ingress.nginx.proxyBodySize`). For the ALB and traefik, check the controller's limit.
- [ ] WebSocket upgrade works for `/socket.io`: a handshake to `wss://<host>/socket.io/?EIO=4&transport=websocket` with the session cookie returns `101`. A foreign `Origin` is refused with `ORIGIN_REJECTED`.
- [ ] The browser actually dials that socket: the header's connection state reads `connected`. A release UI image dials its own origin (#1377); `curl -s https://<host>/runtime-config` shows `"socketUrl":null` unless `METIS_BROWSER_SOCKET_URL` is set on the UI, and then it shows that origin.

## 15. MCP runtime

- [ ] `server.env.MCP_RUNTIME=k8s-sse` is set; the chart does not set it. Until #1380 lands, `/readyz` reports `kubeconfig: fail` for this runtime even when the in-cluster ServiceAccount works.
- [ ] `metis-mcp` namespace exists and is labelled `restricted` (Pod Security Admission).
- [ ] Server can spawn a `runtime: 'k8s-sse'` MCP via the admin UI without RBAC errors in pod logs.
- [ ] Per-MCP NetworkPolicies created by the server are visible in `metis-mcp`.

---

When every box above is ticked, the install is production-ready by the standard 2026 EKS playbook. File items that fail as issues against the operator team — do **not** wave them through.
