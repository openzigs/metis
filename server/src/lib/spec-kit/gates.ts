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
  /** #1583 — every artifact the gate needs that the feature lacks, in phase order. */
  readonly missing: readonly GateArtifact[];
  constructor(required: GateName, message: string, missing: readonly GateArtifact[] = []) {
    super(message);
    this.name = "GateUnmetError";
    this.required = required;
    this.missing = missing;
  }
}

/** The artifacts the phase gates are computed from, in phase order. */
export type GateArtifact = "spec.md" | "plan.md" | "tasks.md";

/**
 * Compute the gate-state of a feature from artifact presence.
 * - `specGate` = `spec.md` exists and is non-empty.
 * - `planGate` = specGate AND `plan.md` exists.
 * - `tasksGate` = planGate AND `tasks.md` exists.
 * - `implementGate` = tasksGate (implement consumes tasks.md).
 */
export async function computeStatus(featureId: string): Promise<FeatureStatus> {
  return (await readGateState(featureId)).status;
}

/** The gate state, and which gate artifacts the feature holds (non-empty). */
async function readGateState(
  featureId: string,
): Promise<{ status: FeatureStatus; present: (key: GateArtifact) => boolean }> {
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
  return { status: { specGate, planGate, tasksGate, implementGate, lastUpdated }, present: has };
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

/** The artifacts each gate needs: its own and every earlier phase's. */
const GATE_ARTIFACTS: Record<GateName, readonly GateArtifact[]> = {
  specGate: ["spec.md"],
  planGate: ["spec.md", "plan.md"],
  tasksGate: ["spec.md", "plan.md", "tasks.md"],
  implementGate: ["spec.md", "plan.md", "tasks.md"],
};

// #786 — each names a command that can satisfy it: since #786 `speckit.tasks`
// with a `featureSlug` writes the feature's own `tasks.md`.
const WRITTEN_BY: Record<GateArtifact, string> = {
  "spec.md": "/speckit.specify",
  "plan.md": "/speckit.plan with this featureSlug",
  "tasks.md": "/speckit.tasks with this featureSlug",
};

/**
 * #1583 — a refusal names every artifact the gate is missing, and the command
 * for the first of them. A feature holding only spec.md was told it lacked
 * tasks.md, and /speckit.tasks then failed on the plan.md it also lacked.
 * `missing` is never empty: a gate is unmet only when one of its artifacts is.
 */
function gateUnmetMessage(missing: readonly GateArtifact[]): string {
  const names =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `${names} ${missing.length === 1 ? "is" : "are"} required — run ${WRITTEN_BY[missing[0]!]} first`;
}

/**
 * Throws `GateUnmetError` (mapped to HTTP 412) when the gate is not met,
 * unless `force: true` is passed — in which case the bypass is audited
 * with `severity: 'high'`.
 */
export async function requireGate(opts: RequireGateOptions): Promise<FeatureStatus> {
  const { status, present } = await readGateState(opts.featureId);
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
    const missing = GATE_ARTIFACTS[opts.gate].filter((key) => !present(key));
    throw new GateUnmetError(opts.gate, gateUnmetMessage(missing), missing);
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
