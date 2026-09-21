---
name: Quarterly DR Drill
about: Checklist for a quarterly disaster-recovery drill (Epic #70).
title: "[DR Drill] <quarter> — Failover exercise"
labels: ["area:dr", "type:drill"]
assignees: []
---

<!--
Opened manually or automatically each quarter by
.github/workflows/dr-drill-schedule.yml. Work top-to-bottom against a
NON-PRODUCTION target (a dedicated drill stack or a maintenance window), timing
each phase. The drill is a dress rehearsal of docs/DR_RUNBOOK.md.
Targets: RPO ≤ 5 min, RTO ≤ 30 min (docs/OPERATIONS.md §10).
-->

## Drill metadata

- **Quarter:** <YYYY-Qn>
- **Date executed:**
- **Incident Commander:**
- **Scribe:**
- **Target:** [ ] dedicated drill stack  [ ] production maintenance window
- **Primary region:**  → **Standby region:**

## Pre-drill

- [ ] Announce the drill window (status page / stakeholders).
- [ ] Confirm the standby-region Helm release is installed (warm standby).
- [ ] Confirm `VAULT_MASTER_KEY` resolves in the standby region.
- [ ] Capture baseline: `pnpm dr:check` against the standby → record `lag` and `status`.

## Failover (time each phase — target RTO ≤ 30 min total)

- [ ] **Declare** the (simulated) incident; start the clock. — _t0_
- [ ] Run `pnpm dr:check`; record lag as the RPO at cutover. — _RPO = ___ s_
- [ ] Promote the Postgres standby (`aws rds promote-read-replica` / `SELECT pg_promote()`).
- [ ] Verify `pg_is_in_recovery()` returns `false` on the promoted node.
- [ ] Scale up + point the standby-region app at the promoted DB + standby S3 bucket.
- [ ] `/readyz` on the standby: `database`, `vault`, `vector` all `ok`.
- [ ] Route53 DNS cutover to the standby ALB.
- [ ] Confirm `dig` + `curl https://<host>/healthz` serve from the standby. — _t_serving_

## Validation

- [ ] Log in and open an existing project.
- [ ] Run a RAG-grounded query (proves pgvector replicated + queryable).
- [ ] Upload a new document (proves standby S3 bucket is writable).
- [ ] No error spike in logs / metrics for 10 min.

## Results

- **Measured RTO** (t_serving − t0): ______  (target ≤ 30 min — [ ] met / [ ] missed)
- **Measured RPO** (lag at cutover): ______  (target ≤ 5 min — [ ] met / [ ] missed)

## Failback (scheduled, post-drill)

- [ ] Re-establish replication in the original direction.
- [ ] `pnpm dr:check` green against the re-attached standby.
- [ ] Cut DNS back (if a real cutover was performed).

## Post-drill

- [ ] File the drill report (timeline, RPO/RTO vs targets).
- [ ] Open follow-up issues for anything that slowed cutover or missed target.
- [ ] Update `docs/DR_RUNBOOK.md` with any corrections found during the drill.

---

_Refs: [`docs/DR_RUNBOOK.md`](../../docs/DR_RUNBOOK.md), [`docs/OPERATIONS.md`](../../docs/OPERATIONS.md) §10, [`docs/EKS_DEPLOYMENT.md`](../../docs/EKS_DEPLOYMENT.md) §9g. Epic #70._
