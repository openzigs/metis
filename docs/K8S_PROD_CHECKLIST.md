# Kubernetes production-readiness checklist

> Walk this list before promoting any METIS install to production traffic. Every item has a `kubectl` (or `aws`) one-liner so the audit can be automated. Items are grouped by acceptance gate.

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
- [ ] Memory `limits` mirror or exceed `docker-compose.prod.yml`: server 1024Mi, embeddings 1536Mi, copilot 768Mi, ui 512Mi.

## 3. PodDisruptionBudgets

- [ ] PDB present for every Deployment that can absorb a drain.  
  `kubectl get pdb -n metis`
- [ ] `ui` `minAvailable: 1`; `server` `minAvailable: 0` (single-pod, brief outage during drain accepted and documented).

## 4. Autoscaling

- [ ] HPA on `ui` (the only stateless component today).  
  `kubectl get hpa -n metis`
- [ ] `server` HPA template is present but `enabled: false` until LanceDB + scheduler + Socket.IO are externalised.

## 5. NetworkPolicy

- [ ] **Default-deny ingress + default-deny egress** scoped to `metis` namespace.  
  `kubectl get networkpolicy -n metis -o yaml | grep -E 'policyTypes|podSelector'`
- [ ] Egress allow-list contains: kube-dns, intra-namespace, AI gateway FQDNs, GitHub host, optional RDS CIDR.
- [ ] Verified with a smoke test: `kubectl run -n metis --rm -it --image=curlimages/curl test -- curl -sS --max-time 5 https://example.com` should fail.
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
  Expected: `JWT_SECRET, VAULT_MASTER_KEY, EMBEDDINGS_TOKEN, COPILOT_NATIVE_TOKEN, DATABASE_URL, OPENAI_API_KEY, GITHUB_TOKEN, METRICS_TOKEN`.
- [ ] When using ESO, the `ExternalSecret` reports `SecretSyncedError: false`.  
  `kubectl get externalsecret metis-secrets -n metis -o jsonpath='{.status.conditions}'`
- [ ] No plaintext secret values committed to Git.

## 9. Image hygiene

- [ ] All four images scanned with Trivy (or ECR scan-on-push) — High/Critical = 0.  
  `trivy image ghcr.io/openzigs/metis-server:<tag>`
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
- [ ] Backup policy in place — Velero schedule **or** EBS snapshot lifecycle policy on the volumes.
- [ ] Restore tested — at least one successful PVC restore drill on a side environment.

## 13. Drain test

- [ ] `kubectl cordon <node>` followed by `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data` completes within `terminationGracePeriodSeconds`.
- [ ] `metis-server` rolls back onto a different node and reaches `Ready` without the LanceDB volume needing manual rescue.

## 14. Ingress + TLS

- [ ] Ingress reaches `Ready` and resolves to a real ALB / nginx LB FQDN.
- [ ] TLS termination working — `curl -v https://<host>/healthz` shows valid cert chain.
- [ ] WebSocket upgrade works for `/socket.io` — UI long-polling fallback should not be needed.

## 15. MCP runtime

- [ ] `metis-mcp` namespace exists and is labelled `restricted` (Pod Security Admission).
- [ ] Server can spawn a `runtime: 'k8s-sse'` MCP via the admin UI without RBAC errors in pod logs.
- [ ] Per-MCP NetworkPolicies created by the server are visible in `metis-mcp`.

---

When every box above is ticked, the install is production-ready by the standard 2026 EKS playbook. File items that fail as issues against the operator team — do **not** wave them through.
