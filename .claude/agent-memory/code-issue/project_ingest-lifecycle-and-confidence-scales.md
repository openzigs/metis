---
name: ingest-lifecycle-and-confidence-scales
description: Ingest/process lifecycle and scoring traps - connector lease is per-process, awaited ingest hooks, git SIGKILL pipes, approval-gate branch, clarification queue, Impact confidence scales (#2482-#2508).
metadata:
  type: project
---

- **Connector ingest lease** (#2482): `ingest-guard.ts` is per-process and code-graph ingest never takes the reindex lease, so a CLI taking `tryAcquireConnectorIngest` cannot exclude the API server's ingests. Check docs claiming "refuses while an ingest runs" for CLI paths.
- **Sync step visibility** (#2482): `ingestCodeGraph` (repo-sync.ts) runs before `sourceIngestState` is written and records nothing another process can see. A CLI can rely on `sourceIngestState` only for the source step, and on the reindex lease only on Postgres.
- **Inline ingest hooks** (#2484): code graph and history hooks are awaited before `abortGuard` on Sync, Deep Ingest and unattended refresh. A new best-effort network await between `ingestCodeGraph` and `abortGuard` lengthens ingest and ignores cancellation.
- **Stopping git promptly** (#2484): SIGKILL on `git fetch` leaves index-pack and git-remote-https holding the stdout pipe, so Node's `close` waits. Spawn detached and kill the group (`process.kill(-pid)`).
- **Approval gate** (#2485): in orchestrator.ts, moving an offer step ahead of the approval-gate read reroutes allowed runs into the blocked branch. Check every other step inside `if (!ticketStatus.allowed)`.
- **Clarification re-run** (#2497): its work goes through the per-analysis `findingsRuns` queue, so prepare can run long after `persistClarificationKnowledge` read dialog state. Values prepare reads (e.g. answeredOnlyVersions' version) can be newer than the answers judged.
- **Impact confidences** (#2508): not on one scale. Data-path writers get 0.4+0.4*p/best (top writer always 0.8); data-model rows are fixed at 0.6. Check any cross-relation threshold (tiers, filters, gates) against each relation's formula.
