/**
 * FinOps → PagerDuty alert channel (Issue #51 / epic #63).
 *
 * Triggers a PagerDuty Events API v2 incident for a budget-threshold breach,
 * REUSING the #580 infrastructure without touching it:
 *   - the per-(workspace, service) routing key is resolved from the #580
 *     {@link PagerDutyServiceConfigStore} (vault-backed, never logged);
 *   - the incident is triggered via the #580 {@link PagerDutyEventsClient}.
 *
 * SEVERITY (justification): a budget alert is an operational/cost signal, NOT a
 * production sev-1 outage — paging on-call at `critical` for every budget tick
 * would be alert fatigue. We map:
 *   - threshold < 100% of budget  → `warning`  (approaching / soft breach)
 *   - threshold >= 100% of budget → `error`    (over budget — harder breach)
 * Never `critical`; that tier is reserved for the #580 infra sev-1 sources
 * (publish rollback, vault-rotation failure, provider down).
 *
 * DEDUP KEY (stable per budget rule): `metis:finops-budget:<workspaceId>:<ruleId>`.
 * Keyed on the RULE (not the tick), so repeated ticks of the same rule collapse
 * into ONE incident rather than spamming a new incident every cadence — the same
 * pattern the #580 alerter uses for its ongoing conditions. Trigger-only: a budget
 * breach has no automatic "cleared" signal, so an operator resolves the incident
 * (mirrors the #580 rollback/rotation one-shot conditions).
 *
 * PER-WORKSPACE ISOLATION: the routing key is resolved by the notification's
 * `workspaceId`, so a workspace's budget alert can only ever page that workspace's
 * own PagerDuty service.
 *
 * NO-OP (not crash) when the workspace has no active PagerDuty config: returns
 * `{ ok:false }`, logged by the dispatcher — exactly like the #580 alerter's silent
 * no-op. Every collaborator is injectable so this module is fully unit-testable.
 */
import type { AlertNotification } from "../alert-engine.js";
import type { PagerDutySeverity } from "../../pagerduty/events-client.js";
import { PagerDutyEventsClient } from "../../pagerduty/events-client.js";
import {
  DEFAULT_SERVICE_KEY,
  getPagerDutyServiceConfigStore,
  type PagerDutyServiceConfigStore,
} from "../../pagerduty/service-config-store.js";

const SOURCE = "metis/finops";

/** Result of a single PagerDuty trigger attempt. */
export interface PagerDutySendResult {
  ok: boolean;
  error?: string;
}

/** Minimal trigger surface (eases testing). */
export interface PagerDutyTriggerClient {
  trigger(input: {
    routingKey: string;
    dedupKey: string;
    summary: string;
    source: string;
    severity?: PagerDutySeverity;
    component?: string;
    customDetails?: Record<string, unknown>;
  }): Promise<unknown>;
}

/** Minimal config-store surface (eases testing). */
export interface PagerDutyRoutingResolver {
  resolveRoutingKey(workspaceId: string, serviceKey?: string): Promise<string | null>;
}

export interface PagerDutySenderDeps {
  client?: PagerDutyTriggerClient | PagerDutyEventsClient;
  configStore?: PagerDutyRoutingResolver | PagerDutyServiceConfigStore;
}

/** Stable dedup key per budget rule so repeated ticks collapse into one incident. */
export function budgetDedupKey(workspaceId: string, ruleId: string): string {
  return `metis:finops-budget:${workspaceId}:${ruleId}`;
}

/** Map a budget breach to a non-critical severity. >=100% is `error`, else `warning`. */
export function budgetSeverity(ratio: number): PagerDutySeverity {
  return ratio >= 1 ? "error" : "warning";
}

/**
 * Trigger a PagerDuty incident for a budget-threshold breach. Resolves the
 * workspace's routing key for `serviceKey` (default "default"); no active config →
 * `{ ok:false }` no-op (logged by the dispatcher). A genuine transport error
 * propagates and is caught by the dispatcher's per-channel wrapper.
 */
export async function sendPagerDutyAlert(
  notification: AlertNotification,
  serviceKey: string | undefined,
  deps: PagerDutySenderDeps = {},
): Promise<PagerDutySendResult> {
  const configStore = (deps.configStore ??
    getPagerDutyServiceConfigStore()) as PagerDutyRoutingResolver;
  const svc = (serviceKey ?? "").trim() || DEFAULT_SERVICE_KEY;

  const routingKey = await configStore.resolveRoutingKey(notification.workspaceId, svc);
  if (!routingKey) {
    return { ok: false, error: "no active PagerDuty config for workspace" };
  }

  const client = (deps.client ?? new PagerDutyEventsClient()) as PagerDutyTriggerClient;
  const pct = Math.round(notification.ratio * 100);
  await client.trigger({
    routingKey,
    dedupKey: budgetDedupKey(notification.workspaceId, notification.ruleId),
    summary:
      `[budget] ${notification.workspaceName}: rule "${notification.ruleName}" ` +
      `at ${pct}% of budget (${notification.basis})`.slice(0, 1024),
    source: SOURCE,
    severity: budgetSeverity(notification.ratio),
    component: "finops",
    // SANITIZED context — ids + numeric figures + a human reason, never secrets.
    customDetails: {
      workspaceId: notification.workspaceId,
      workspaceName: notification.workspaceName,
      ruleId: notification.ruleId,
      ruleName: notification.ruleName,
      thresholdPct: notification.thresholdPct,
      basis: notification.basis,
      spendCents: notification.spendCents,
      budgetCents: notification.budgetCents,
      ratio: notification.ratio,
      firedAt: notification.firedAt,
    },
  });
  return { ok: true };
}
