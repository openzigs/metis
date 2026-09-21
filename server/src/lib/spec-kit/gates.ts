/**
 * Epic #396 (MVP-8) — Phase status gates.
 *
 * Each Spec Kit phase has a precondition gate. Calls to `/speckit.plan`,
 * `/speckit.tasks`, `/speckit.implement`, `/speckit.taskstoissues` must
 * `requireGate(...)` before doing any work. The route layer maps the
 * thrown `GateUnmetError` to HTTP 412 Precondition Failed.
 *
 * Break-glass: callers may pass `force: true` (mapped from header
 * `X-Speckit-Force: true`) to bypass — the bypass is audit-logged with
 * `severity: 'high'`.
 *
 * Status is derived from the per-feature artifact set so it never falls
 * out of sync with reality (no separate status table to mutate).
 */
import { audit } from "../audit/audit-service.js";
import { listFeatureArtifacts } from "./feature-artifacts.js";

export type GateName = "specGate" | "planGate" | "tasksGate" | "implementGate";

export interface FeatureStatus {
  specGate: boolean;
  planGate: boolean;
  tasksGate: boolean;
  implementGate: boolean;
  lastUpdated: string;
}

export class GateUnmetError extends Error {
  readonly status = 412;
  readonly code = "SPECKIT_GATE_UNMET";
  readonly required: GateName;
  constructor(required: GateName, message: string) {
    super(message);
    this.name = "GateUnmetError";
    this.required = required;
  }
}

/**
 * Compute the gate-state of a feature from artifact presence.
 * - `specGate` = `spec.md` exists and is non-empty.
 * - `planGate` = specGate AND `plan.md` exists.
 * - `tasksGate` = planGate AND `tasks.md` exists.
 * - `implementGate` = tasksGate (implement consumes tasks.md).
 */
export async function computeStatus(featureId: string): Promise<FeatureStatus> {
  const artifacts = await listFeatureArtifacts(featureId);
  const has = (key: string) => artifacts.some((a) => a.key === key && a.content.trim().length > 0);
  const specGate = has("spec.md");
  const planGate = specGate && has("plan.md");
  const tasksGate = planGate && has("tasks.md");
  const implementGate = tasksGate;
  const lastUpdated =
    artifacts.length === 0
      ? new Date(0).toISOString()
      : artifacts
          .map((a) => a.updatedAt)
          .sort()
          .reverse()[0]!;
  return { specGate, planGate, tasksGate, implementGate, lastUpdated };
}

export interface RequireGateOptions {
  featureId: string;
  gate: GateName;
  /** When true, bypass the check and emit a high-severity audit event. */
  force?: boolean;
  actorId?: string | null;
  /** Identifier of the calling command (for audit metadata). */
  command?: string;
}

const GATE_MESSAGES: Record<GateName, string> = {
  specGate: "spec.md is required — run /speckit.specify first",
  planGate: "plan.md is required — run /speckit.plan first",
  tasksGate: "tasks.md is required — run /speckit.tasks first",
  implementGate: "tasks.md is required — run /speckit.tasks first",
};

/**
 * Throws `GateUnmetError` (mapped to HTTP 412) when the gate is not met,
 * unless `force: true` is passed — in which case the bypass is audited
 * with `severity: 'high'`.
 */
export async function requireGate(opts: RequireGateOptions): Promise<FeatureStatus> {
  const status = await computeStatus(opts.featureId);
  const met = status[opts.gate];
  if (opts.force) {
    audit({
      actor: opts.actorId ? { id: opts.actorId } : null,
      action: "speckit.gate.forced",
      target: { type: "speckit_feature", id: opts.featureId },
      metadata: {
        gate: opts.gate,
        command: opts.command ?? null,
        severity: "high",
        wasMet: met,
      },
    });
    return status;
  }
  if (!met) {
    throw new GateUnmetError(opts.gate, GATE_MESSAGES[opts.gate]);
  }
  return status;
}

/**
 * Serialize the status as the body of `.specify/<feature>/status.json`,
 * written by the MVP-7 installer. Format matches upstream proposal
 * `github/spec-kit#738`.
 */
export function statusJsonBody(status: FeatureStatus): string {
  return `${JSON.stringify(status, null, 2)}\n`;
}
