# METIS — Disaster Recovery Runbook

> **Purpose:** step-by-step failover of a METIS deployment from its primary
> region to the standby region, and the controlled failback afterward. Pair with
> [`OPERATIONS.md`](./OPERATIONS.md) §10 (RPO/RTO targets + the `dr:check`
> tool) and [`EKS_DEPLOYMENT.md`](./EKS_DEPLOYMENT.md) §9g (the replication
> infra this runbook assumes).
>
> **Targets:** RPO ≤ 5 min, RTO ≤ 30 min. Epic #70.

---

## 0. Architecture recap (what fails over)

Post epic #518, all durable state is two stores, so DR is two replication
streams plus a DNS swap:

| State | Store | Cross-region mechanism | After promotion |
|---|---|---|---|
| App data + **RAG vectors (pgvector)** | **Postgres** (#539, #543) | Postgres streaming replication (WAL) | Standby is **promoted** to primary. |
| Uploaded blobs | **S3** (#546) | S3 Cross-Region Replication (CRR) | Standby bucket becomes the active `UPLOAD_S3_BUCKET`. |
| Connector/vault secrets | **AWS Secrets Manager** | Multi-region secret replication / ESO | `VAULT_MASTER_KEY` must resolve in the standby region. |

There is **no separate LanceDB step** — vectors ride the Postgres WAL stream.

> **Assumption:** the METIS Helm release is **pre-installed** in the standby
> region as a warm standby (chart applied, `server.replicaCount` low or 0,
> pointed at the standby Postgres and standby S3 bucket via its own
> `values-prod.yaml` + secret). A cold `helm install` at failover time will
> blow the 30-min RTO.

---

## 1. Declare the incident (target: ≤ 5 min)

1. Confirm the primary is actually down (not a transient blip): `/healthz` and
   `/readyz` failing for > 2 min, or a region-wide AWS event.
2. Page the DR on-call and open an incident channel. Assign an **Incident
   Commander** (owns the go/no-go) and a **Scribe** (timestamps every step for
   the post-mortem).
3. Check standby replication health **before** committing to failover:
   ```bash
   DATABASE_URL=postgres://…@metis-standby.us-west-2:5432/metis \
     pnpm dr:check
   ```
   - Exit `0` → standby is within the lag threshold; safe to promote (bounded
     data loss ≤ RPO).
   - Exit `1` (`status=lagging`) → note the reported `lag=<n>s`; promoting now
     loses that much data. IC decides go/no-go.
   - Exit `1` (`status=no-standby`/`error`) → **stop.** The standby is not a
     replica or is unreachable — escalate to DBA; do not promote a non-replica.
4. **Go/no-go decision.** IC declares failover.

---

## 2. Promote the Postgres standby (target: ≤ 5 min)

### RDS / Aurora (managed)
```bash
# Promotes the cross-Region read replica to a standalone writable primary.
aws rds promote-read-replica \
  --db-instance-identifier metis-standby \
  --region us-west-2
# Wait until Status = available and it accepts writes:
aws rds wait db-instance-available --db-instance-identifier metis-standby --region us-west-2
```

### Self-managed Postgres 16
```bash
# On the standby, as a superuser. Ends recovery and makes the node writable.
psql "$STANDBY_DATABASE_URL" -c "SELECT pg_promote(wait => true, wait_seconds => 60);"
# Verify it left recovery (expect: f):
psql "$STANDBY_DATABASE_URL" -c "SELECT pg_is_in_recovery();"
```

- After promotion the pgvector `rag_vectors` table + HNSW index are already
  present (they replicated with the schema) — no rebuild needed. RAG works
  immediately once the app points at the promoted node.
- **Fencing:** if the old primary is still alive (partial outage / split brain),
  stop it or revoke its network access **now** so no writes land on the
  soon-to-be-stale node.

---

## 3. Cut the application over (target: ≤ 10 min)

1. Point the standby-region METIS release at the **promoted** Postgres and the
   standby S3 bucket, then scale up:
   ```bash
   # The standby values/secret already carry the standby DATABASE_URL + bucket.
   helm upgrade metis ./deploy/helm/metis -n metis \
     -f deploy/helm/metis/values-prod.yaml \
     --set server.replicaCount=2 --set ui.replicaCount=2
   kubectl -n metis rollout status deploy/metis-server --timeout=300s
   ```
2. Confirm the pods are ready and connected to the promoted DB:
   ```bash
   kubectl -n metis get pods -l app.kubernetes.io/component=server
   # Deep readiness (DB + vault + vector store + scheduler + AI provider):
   kubectl -n metis exec deploy/metis-server -- \
     curl -fsS localhost:4000/readyz | jq .
   ```
   - `database: ok`, `vault: ok` (proves `VAULT_MASTER_KEY` resolved in-region),
     `vector: ok`.
   - If `vault` fails → the standby region cannot read `VAULT_MASTER_KEY`; fix
     secret replication before proceeding (connector secrets are unusable until
     then — see §0).

---

## 4. DNS cutover (target: ≤ 10 min)

The app record should carry a **low TTL (≤ 60 s)** in steady state so this step
is not gated on stale caches.

```bash
# Swap the Route53 record to the standby-region ALB.
aws route53 change-resource-record-sets \
  --hosted-zone-id "$ZONE_ID" \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "metis.example.com",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "<standby-alb-hosted-zone-id>",
          "DNSName": "<standby-alb-fqdn>.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'
```

- If you use **ExternalDNS**, update the Ingress host annotation in the standby
  release and let ExternalDNS reconcile — but for DR prefer the explicit
  `change-resource-record-sets` above so cutover is not gated on a reconcile
  loop.
- Prefer **Route53 health-check failover records** configured ahead of time so
  the swap is automatic; the manual command is the break-glass path.

---

## 5. Validate (target: within the RTO window)

```bash
# External DNS resolves to the standby ALB:
dig +short metis.example.com

# App is serving from the standby region:
curl -fsS https://metis.example.com/healthz          # {"status":"ok"}
curl -fsS https://metis.example.com/readyz | jq .     # all subsystems ok

# Standby is now a PRIMARY (no longer in recovery) — dr:check reports no-standby,
# which is EXPECTED post-promotion (there is no downstream replica yet).
DATABASE_URL="$PROMOTED_DATABASE_URL" pnpm dr:check || true
```

Functional smoke test: log in, open an existing project, run a small
RAG-grounded query (proves pgvector replicated + is queryable), and upload a new
document (proves the standby S3 bucket is writable).

**Record the actual RPO/RTO achieved** (Scribe): time from outage → serving, and
the `dr:check` lag observed at §1.3.

---

## 6. Communications

| Audience | When | Channel |
|---|---|---|
| On-call + eng | Incident declared (§1) | Incident channel / PagerDuty |
| Stakeholders | Failover committed (§2 go) | Status page: "degraded → failing over" |
| Users | App serving from standby (§5) | Status page: "recovered (DR region)" |
| All | Post-incident | Post-mortem doc within 48h |

---

## 7. Failback (planned, NOT during the incident)

Failback is a **scheduled** maintenance activity once the original region is
healthy — never rushed mid-incident.

1. Rebuild the original primary region as a **standby of the current
   (promoted) primary**: create a cross-Region read replica in the old region
   streaming from the new primary; re-establish S3 CRR in the reverse direction.
2. Let it catch up. Verify with `pnpm dr:check` against the new standby until it
   reports `status=healthy`.
3. Schedule a maintenance window, then repeat §2–§5 in reverse to promote the
   original region and cut DNS back.
4. Re-arm the normal replication direction (original primary → DR standby) and
   confirm `dr:check` green.

---

## 8. Post-incident

- File the post-mortem (timeline, actual RPO/RTO vs targets, what slowed
  cutover).
- Reconcile any writes lost within the RPO window (S3 blobs not yet replicated
  are re-uploadable from source; Postgres data loss is bounded by the measured
  lag).
- Feed lessons into the **quarterly DR drill** checklist
  ([`.github/ISSUE_TEMPLATE/dr-drill.md`](../.github/ISSUE_TEMPLATE/dr-drill.md)).

---

## 9. Rollback (failover went wrong)

If the standby proves unhealthy **after** promotion but the original primary is
still intact and un-fenced:

1. **Do not** point production traffic at a half-promoted node. Keep DNS on the
   last-known-good region.
2. If DNS was already cut and the standby is failing readiness, revert the
   Route53 record to the original ALB (§4 in reverse) — safe only if the
   original primary was never written to after the split (see §2 fencing).
3. If both nodes may have taken writes (split brain), stop all writers,
   escalate to DBA, and reconcile from WAL/backups before restoring traffic. An
   untested split-brain reconciliation is worse than extended downtime — take
   the time.

See [`OPERATIONS.md`](./OPERATIONS.md) §3 for backup/restore as the last resort.
