---
name: github-webhook-dedup-and-routing
description: GitHub and Jira webhook receivers — delivery-id dedup scope (one GUID per event across every hook), replay windows, shared-secret vs per-connector routing, derived webhook secrets, and the event fields that lie (#1480 to #1513).
metadata:
  type: project
---

From the 2026-10-24 webhook/security wave: #1480, #1483, #1491, #1501, #1508, #1513 and their
reviews and panels. Code: `server/src/routes/webhooks-github.ts`, `payload-replay.ts`, the
Jira receiver in `routes/sync.ts`.

**Delivery ids and dedup.**
- **GitHub sends the SAME `X-GitHub-Delivery` GUID to every webhook subscribed to an event**
  (#1501 panel). Delivery-id dedup must be scoped by receiver and signer, never keyed on the
  bare GUID (fixed for PR routing in #1506/#1508, for drift events in #1513).
- **A missing delivery-id header turns dedup off silently.** `recordDelivery("")` writes no
  row. When reviewing a change to which header is read, check that a missing one is visible in
  logs (#1513 review).
- **Jira `X-Atlassian-Webhook-Identifier` is unique only within one Jira Cloud tenant.** The
  receiver keys dedup as `jira-issues:deployment:<id>`, so tenants sharing
  `JIRA_WEBHOOK_SECRET` could collide; scope by tenant (e.g. the base URL from `issue.self`)
  if multi-tenant Jira is ever supported (#1513).
- **A reliability dedup repurposed as the only replay guard inherits the wrong failure
  mode.** "Never block the webhook" fail-open becomes a silent security bypass. Re-check
  fail-open vs fail-closed whenever a dedup table becomes a security control (#1491 review).

**Replay windows.** An `isStale*` window bounds replay only for bodies carrying the timestamp
it reads. On receivers accepting arbitrary GitHub events (triggers), bodies without one rely
on the 7-day `webhook_payload_digests` retention; check which events lack a readable signed
time whenever `payload-replay.ts` is reused (#1501 review). GitHub `release.created_at` is
the release's COMMIT date, not the release's: never use it as an event time.

**Routing.**
- Shared-secret PR routing requires connector status `"connected"` (earliest `repoBoundAt`
  wins). Tests seeding a `repoConnection` that expect a deployment-signed review must set
  status `"connected"` and, for GHE, send `repository.html_url` on the Enterprise host. The
  per-connector receiver is `/github/pr/c/:connectorId` (#1480). "connected" proves little:
  [[repo-connector-proof-and-vault-writes]].
- On a shared-secret hook, **issue events route by their export/published-issue row**, not
  by repo-connector ownership: issue hooks sit on a tracker repo that usually is not the
  connected one (#1483).
- Claiming non-matching triggers (to block relabel replays) interacts with the trigger
  fan-out cap; test the two together (#1501 cycle 2).

**Per-connector secrets.**
- They are derived (HMAC over HKDF(`VAULT_MASTER_KEY`), connectorId, nonce), not
  vault-encrypted: an unauthenticated receiver cannot afford an argon2id decrypt per
  candidate (#1480).
- Secrets derived from `VAULT_MASTER_KEY` are not covered by the `docs/OPERATIONS.md` §4
  rotation runbook. Any derive-from-master-key design needs a fingerprint/version and a
  runbook line (#1480 review).
- Verifying against several candidate secrets costs candidates × body size (up to 10 MiB)
  before auth and leaks the candidate count by timing. Prefer a per-target receiver URL, and
  index the lookup columns (#1480 review).

Related: [[review-heuristics-hidden-uniqueness-and-dead-claims]],
[[server-test-suite-traps-webhook-wave]], [[secret-binding-fire-time-checks]].
