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
- [ ] `helm upgrade` after an HPA has scaled: Helm 4 fails with a `.spec.replicas` conflict until #1378 lands. Pass `--force-conflicts` until then.

## 5. NetworkPolicy

- [ ] **Default-deny ingress + default-deny egress** scoped to `metis` namespace.  
  `kubectl get networkpolicy -n metis -o yaml | grep -E 'policyTypes|podSelector'`
- [ ] Egress allow-list contains: kube-dns, intra-namespace, AI gateway FQDNs, GitHub host, optional RDS CIDR.
- [ ] The policy actually selects the METIS pods. The command below must list every pod. **Today it lists none (#1374)**, so the policy isolates nothing.  
  `kubectl get pods -n metis -l "$(kubectl get networkpolicy -n metis metis-default-deny -o jsonpath='{.spec.podSelector.matchLabels}' | jq -r 'to_entries|map("\(.key)=\(.value)")|join(",")')"`
- [ ] Verified with a smoke test **from the server pod itself**. A bare `kubectl run … curlimages/curl` proves nothing: PSA `restricted` rejects it, and without the chart's labels the policy would never select it. Expect a non-allow-listed host to fail and the embeddings sidecar to answer:  
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
- [ ] Only the server receives the vault key, JWT secret and provider tokens. Today every key goes to every Deployment, including the UI (#1375), so this item fails until that lands:  
  `kubectl get deploy metis-ui -n metis -o yaml | grep -c VAULT_MASTER_KEY` should return `0`.

## 9. Image hygiene

- [ ] All four images (`metis-server`, `metis-ui`, `metis-embeddings-svc`, `metis-sql-lineage`) are published for the tag. `build-images.yml` publishes only the first three today (#1382).
- [ ] All four images scanned with Trivy (or ECR scan-on-push) — High/Critical = 0.  
  `trivy image --scanners vuln --severity HIGH,CRITICAL ghcr.io/openzigs/metis-server:<tag>`  
  No image met this in #1312. Every image had fixable HIGH findings, and three had CRITICAL ones (#1379).
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
- [ ] The browser actually dials that socket. Today the release UI image dials `http://localhost:4000` instead (#1377), so live updates do not connect behind an ingress.

## 15. MCP runtime

- [ ] `server.env.MCP_RUNTIME=k8s-sse` is set; the chart does not set it. Until #1380 lands, `/readyz` reports `kubeconfig: fail` for this runtime even when the in-cluster ServiceAccount works.
- [ ] `metis-mcp` namespace exists and is labelled `restricted` (Pod Security Admission).
- [ ] Server can spawn a `runtime: 'k8s-sse'` MCP via the admin UI without RBAC errors in pod logs.
- [ ] Per-MCP NetworkPolicies created by the server are visible in `metis-mcp`.

---

When every box above is ticked, the install is production-ready by the standard 2026 EKS playbook. File items that fail as issues against the operator team — do **not** wave them through.
