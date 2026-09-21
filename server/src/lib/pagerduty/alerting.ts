/**
 * Issue #580 (epic #63) — sev-1 alerting orchestration.
 *
 * `PagerDutyAlerter` is the thin, best-effort layer the three sev-1 sources call.
 * For each event it:
 *   1. Resolves the owning workspace's routing key for the target service (no
 *      config → silent no-op, exactly like the #67 notification hooks).
 *   2. Builds a STABLE dedup key per logical incident (so an ongoing condition
 *      collapses into a single incident rather than spamming new ones).
 *   3. Triggers (or, for recoverable conditions, resolves) a PagerDuty incident
 *      with a SANITIZED context payload (ids + a human reason — never secrets).
 *
 * BEST-EFFORT / NON-THROWING: every public method catches and logs. A PagerDuty
 * API failure, a vault read failure, or a missing config must NEVER break the
 * originating operation (publish / rotation / health). This mirrors the #67
 * notification hook contract.
 *
 * DEDUP-KEY SCHEME (stable per logical incident):
 *   - publish rollback        → `metis:publish-rollback:<batchId>`        (trigger only — one-shot)
 *   - vault rotation failure  → `metis:vault-rotation-failure:<secretId>` (trigger only — one-shot)
 *   - provider/sandbox down   → `metis:provider-down:<serverId>`          (trigger on error, RESOLVE on recovery)
 *
 * Provider-down is the only condition with a clear "cleared" signal (the MCP
 * lifecycle flips a server back to `ready`), so it is the only trigger+resolve
 * source. Rollback and rotation failure are discrete one-shot events with no
 * automatic clear, so they are trigger-only and an operator resolves them.
 */
import { createChildLogger } from "../logger.js";
import { DEFAULT_SERVICE_KEY } from "./service-config-store.js";
import type { PagerDutyServiceConfigStore } from "./service-config-store.js";
import type { PagerDutyEventsClient } from "./events-client.js";

const log = createChildLogger("pagerduty-alerting");

const SOURCE = "metis";

/** Minimal client surface the alerter needs (eases testing). */
export interface AlerterClient {
  trigger(input: {
    routingKey: string;
    dedupKey: string;
    summary: string;
    source: string;
    severity?: "critical" | "error" | "warning" | "info";
    component?: string;
    customDetails?: Record<string, unknown>;
  }): Promise<unknown>;
  resolve(input: { routingKey: string; dedupKey: string }): Promise<unknown>;
}

/** Minimal config-store surface the alerter needs. */
export interface AlerterConfigStore {
  resolveRoutingKey(workspaceId: string, serviceKey?: string): Promise<string | null>;
}

export interface PagerDutyAlerterDeps {
  client: AlerterClient | PagerDutyEventsClient;
  configStore: AlerterConfigStore | PagerDutyServiceConfigStore;
}

export interface PublishRollbackEvent {
  workspaceId: string;
  projectId: string;
  projectName: string;
  batchId: string;
  reason: string;
  repo: string | null;
  serviceKey?: string;
}

export interface VaultRotationFailureEvent {
  workspaceId: string;
  secretId: string;
  label: string;
  reason: string;
  serviceKey?: string;
}

export interface ProviderDownEvent {
  workspaceId: string;
  serverId: string;
  label: string;
  lastError: string;
  serviceKey?: string;
}

export interface ProviderRecoveredEvent {
  workspaceId: string;
  serverId: string;
  serviceKey?: string;
}

export class PagerDutyAlerter {
  private readonly client: AlerterClient;
  private readonly configStore: AlerterConfigStore;

  constructor(deps: PagerDutyAlerterDeps) {
    this.client = deps.client as AlerterClient;
    this.configStore = deps.configStore as AlerterConfigStore;
  }

  /** publish rollback → trigger-only critical incident. */
  async publishRollback(ev: PublishRollbackEvent): Promise<void> {
    await this.safeTrigger(ev.workspaceId, ev.serviceKey, {
      dedupKey: `metis:publish-rollback:${ev.batchId}`,
      summary: `[sev-1] Publish auto-rollback in "${ev.projectName}": ${ev.reason}`,
      component: "publishing",
      customDetails: {
        workspaceId: ev.workspaceId,
        projectId: ev.projectId,
        projectName: ev.projectName,
        batchId: ev.batchId,
        reason: ev.reason,
        repo: ev.repo,
      },
    });
  }

  /** vault key rotation failure → trigger-only critical incident. */
  async vaultRotationFailure(ev: VaultRotationFailureEvent): Promise<void> {
    await this.safeTrigger(ev.workspaceId, ev.serviceKey, {
      dedupKey: `metis:vault-rotation-failure:${ev.secretId}`,
      summary: `[sev-1] Vault key rotation failed for secret "${ev.label}"`,
      component: "vault",
      customDetails: {
        workspaceId: ev.workspaceId,
        secretId: ev.secretId,
        label: ev.label,
        reason: ev.reason,
      },
    });
  }

  /** provider/sandbox down → trigger a critical incident (resolved on recovery). */
  async providerDown(ev: ProviderDownEvent): Promise<void> {
    await this.safeTrigger(ev.workspaceId, ev.serviceKey, {
      dedupKey: `metis:provider-down:${ev.serverId}`,
      summary: `[sev-1] Provider/sandbox down: "${ev.label}" — ${ev.lastError}`,
      component: "mcp-provider",
      customDetails: {
        workspaceId: ev.workspaceId,
        serverId: ev.serverId,
        label: ev.label,
        lastError: ev.lastError,
      },
    });
  }

  /** provider/sandbox back up → resolve the matching provider-down incident. */
  async providerRecovered(ev: ProviderRecoveredEvent): Promise<void> {
    const workspaceId = ev.workspaceId?.trim();
    if (!workspaceId) return;
    try {
      const routingKey = await this.configStore.resolveRoutingKey(
        workspaceId,
        ev.serviceKey ?? DEFAULT_SERVICE_KEY,
      );
      if (!routingKey) return;
      await this.client.resolve({
        routingKey,
        dedupKey: `metis:provider-down:${ev.serverId}`,
      });
    } catch (err) {
      log.warn("PagerDuty resolve failed (swallowed)", {
        serverId: ev.serverId,
        error: (err as Error).message,
      });
    }
  }

  // ── internal ────────────────────────────────────────────────────────────────

  private async safeTrigger(
    workspaceId: string | undefined,
    serviceKey: string | undefined,
    payload: {
      dedupKey: string;
      summary: string;
      component: string;
      customDetails: Record<string, unknown>;
    },
  ): Promise<void> {
    const ws = workspaceId?.trim();
    if (!ws) return;
    try {
      const routingKey = await this.configStore.resolveRoutingKey(
        ws,
        serviceKey ?? DEFAULT_SERVICE_KEY,
      );
      if (!routingKey) return;
      await this.client.trigger({
        routingKey,
        dedupKey: payload.dedupKey,
        summary: payload.summary.slice(0, 1024),
        source: SOURCE,
        severity: "critical",
        component: payload.component,
        customDetails: payload.customDetails,
      });
    } catch (err) {
      log.warn("PagerDuty trigger failed (swallowed)", {
        dedupKey: payload.dedupKey,
        error: (err as Error).message,
      });
    }
  }
}
