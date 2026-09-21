# PagerDuty sev-1 alerting (Events API v2)

> Issue #580, epic #63. Standalone — independent of the Slack (#579) and Teams
> (#578/#67) integrations.

METIS opens **PagerDuty incidents** for sev-1 (severity `critical`) operational
conditions using the [PagerDuty **Events API v2**](https://developer.pagerduty.com/docs/events-api-v2/overview/)
`enqueue` endpoint. Three existing event sources page on-call when something
critical happens; **dedup keys** keep a single ongoing condition to one incident,
and conditions with a clear "cleared" signal **auto-resolve**.

This integration is deliberately thin and best-effort: a PagerDuty outage, an
unconfigured workspace, or a malformed response **never** affects the originating
operation (a publish, a key rotation, or an MCP health check).

---

## Setup — register a routing key per service

PagerDuty's unit of routing is a **service**: each PagerDuty service exposes an
*Events API v2 integration* that issues a **routing (integration) key**. In METIS
a routing key is registered **per workspace, per logical service** (`serviceKey`,
default `"default"`).

1. In PagerDuty, create (or pick) a **Service**, add an **Events API v2**
   integration, and copy its **Integration Key** (32-char routing key).
2. As a **workspace admin**, register it with METIS:

   ```http
   POST /api/integrations/pagerduty/workspaces/{workspaceId}/service-configs
   Content-Type: application/json

   { "serviceKey": "default", "routingKey": "<paste the integration key>", "label": "Prod on-call" }
   ```

   - `serviceKey` is a free-form logical name. Use a single `"default"` for simple
     setups, or split event classes (e.g. `"publishing"`, `"infra"`) across
     different PagerDuty services. Defaults to `"default"` when omitted.
   - The **routing key is write-only**: it is encrypted into the METIS vault and is
     **never** returned by any API, logged, or stored in plaintext on the config row.
3. List or remove configs:

   ```http
   GET    /api/integrations/pagerduty/workspaces/{workspaceId}/service-configs
   DELETE /api/integrations/pagerduty/workspaces/{workspaceId}/service-configs/{serviceKey}
   ```

All three endpoints require `requireAuth` + `requireWorkspaceRole("admin")`. The
workspace is taken from the URL path, so an admin can only ever configure their
**own** workspace.

### Platform-level (ops) workspace

Some sev-1 conditions are **not** tied to a tenant workspace:

- **Vault key rotation failures** — vault secrets are platform/project-scoped, not
  workspace-scoped.
- **Provider/sandbox down** for `global`- or `user`-scoped MCP servers (no project
  → no workspace to derive).

To page on those, set **`PAGERDUTY_OPS_WORKSPACE_ID`** to the id of a workspace
whose registered PagerDuty service should receive platform-infra incidents. When
unset, platform-level alerting is simply disabled — tenant-scoped alerts (e.g.
project publish rollbacks) still page because they derive their workspace from the
project.

---

## Which events trigger / resolve

| Source | Where it fires | Severity | Dedup key | Resolve? |
|--------|----------------|----------|-----------|----------|
| **Publish rollback** | The >50%-failure **auto-rollback** path in `publisher.ts` (workspace from the batch's project) | `critical` | `metis:publish-rollback:<batchId>` | **No** — one-shot event, an operator resolves it |
| **Vault key rotation failure** | The `POST /vault/:id/rotate` failure branch (routes to the **ops workspace**) | `critical` | `metis:vault-rotation-failure:<secretId>` | **No** — one-shot event |
| **Provider / sandbox down** | The MCP lifecycle `error` transition, observed on `lifecycle.onStatus` (project workspace, else ops workspace) | `critical` | `metis:provider-down:<serverId>` | **Yes** — auto-resolves when the server returns to `ready` |
| **FinOps budget alert** (#51) | The FinOps alert engine when a workspace's budget rule trips (only when a `pagerduty` alert channel is configured) | `warning` (<100% of budget) / `error` (≥100%) | `metis:finops-budget:<workspaceId>:<ruleId>` | **No** — an operator resolves it |

**Why the budget-alert severity is NOT critical:** a budget alert is an operational
cost signal, not a production outage. Paging on-call at `critical` for every budget
tick would be alert fatigue, so budget breaches map to `warning` (approaching /
soft breach) or `error` (over budget). `critical` stays reserved for the three
infra sev-1 sources above. The dedup key is keyed on the **rule** (`workspaceId` +
`ruleId`), so repeated ticks of the same rule collapse into one incident. The
routing key / service is resolved per-workspace exactly like the sev-1 sources
(via `config.serviceKey`, default `"default"`). Configure it as a FinOps alert
channel of type `pagerduty` alongside `email` / `webhook` / `slack`.

**Why these resolve choices:** provider-down is the only condition with a clear,
machine-observable "cleared" signal (the MCP lifecycle manager flips a server back
to `ready`), so it is **trigger + resolve**. A publish rollback and a vault rotation
failure are discrete one-shot events with no automatic clear, so they are
**trigger-only** — an operator resolves the PagerDuty incident once handled.

> The publish-rollback **PagerDuty incident** (this integration) and the #67 Teams
> publish-rolled-back **notification card** are independent and **both** fire — one
> is a page, the other an informational card. That overlap is intended.

---

## Dedup behaviour

Each incident carries a **stable `dedup_key`** built from the logical condition's
identity (the batch id, secret id, or server id — see the table above). PagerDuty
collapses repeated `trigger`s with the same `dedup_key` into a **single open
incident** rather than creating a new one each time.

For provider-down, the watcher additionally uses **edge detection**: it pages only
on the *transition* into `error` (not on every health tick while the server stays
down) and issues a `resolve` with the **same** `dedup_key` on the transition back
to `ready`. The result is exactly one incident per outage, automatically resolved
on recovery.

---

## Incident payload

A triggered incident uses the v2 payload shape:

```jsonc
{
  "routing_key": "<from the vault>",
  "event_action": "trigger",
  "dedup_key": "metis:provider-down:srv-3",
  "payload": {
    "summary": "[sev-1] Provider/sandbox down: \"filesystem-mcp\" — transport_closed:exited",
    "source": "metis",
    "severity": "critical",
    "component": "mcp-provider",
    "custom_details": { "workspaceId": "...", "serverId": "srv-3", "label": "filesystem-mcp", "lastError": "transport_closed:exited" }
  }
}
```

`custom_details` carries only **ids and a human-readable reason** — never secrets,
credentials, or PII.

---

## Security model

- **Routing key encrypted at rest.** The plaintext key is written to the hardened
  AES-256-GCM vault (`server/src/lib/vault/vault-service.ts`) under a deterministic
  label; only a `${vault:label}` reference is stored on `pagerduty_service_configs`.
  This mirrors the #548 Teams bot-password pattern. The key never appears in a row,
  a log line, an API response, or a thrown error.
- **Per-workspace isolation.** Every store read/write and every trigger is keyed by
  `workspaceId`. A workspace's events can only ever resolve — and fire to — its own
  routing key; one workspace can never page through another's service.
- **No secret/PII leakage** in incident payloads (ids + reason only).
- **Egress.** All PagerDuty calls go through the SSRF-safe `safeFetch` helper.
- **Failure isolation.** A PagerDuty API failure, a vault-read failure, or a missing
  config is logged and swallowed — the originating publish / rotation / health
  operation is never affected.

---

## Configuration reference

| Variable | Purpose | Default |
|----------|---------|---------|
| `PAGERDUTY_OPS_WORKSPACE_ID` | Workspace whose PagerDuty service receives **platform-level** sev-1 alerts (vault rotation failures, non-project provider-down) | unset → platform alerting disabled |

Routing keys are **not** configured via environment variables — they are registered
through the admin API and stored encrypted in the vault (an env-var key would defeat
the at-rest-encryption requirement).
