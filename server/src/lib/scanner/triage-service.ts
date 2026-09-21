/**
 * Epic #708 / Issue #714 — Triage service.
 *
 * Pure-logic side of the triage workflow. The route layer wraps these
 * helpers with prisma transactions + audit logging. Keeping the rules
 * in a pure module makes them trivially testable.
 *
 * Materialisation contract: an approved ScanFinding becomes a Finding
 * row, linked by `Finding.scanFindingId @unique`. Idempotency is
 * enforced by checking `materializedFindingId` is null before insertion.
 */
import type { Severity, TriageStatus } from "./types.js";

export interface ScanFindingForTriage {
  id: string;
  scanId: string;
  projectId: string;
  repoConnectionId: string;
  symbolId: string;
  qualifiedName: string;
  ruleId: string | null;
  title: string;
  body: string;
  severity: Severity;
  category: string;
  evidenceLines: number[];
  filePath: string;
  fingerprint: string;
  confidence: number;
  triageStatus: TriageStatus;
  materializedFindingId: string | null;
}

export interface MaterialisedFindingInput {
  projectId: string;
  symbolId: string;
  title: string;
  body: string;
  severity: Severity;
  category: string;
  evidenceLines: number[];
  filePath: string;
  scanFindingId: string;
  derivation: "inferred";
  confidence: number;
}

export interface TriageDecisionInput {
  scanFindingId: string;
  decision: Exclude<TriageStatus, "pending">;
  actorId: string;
  /** Optional reviewer note appended to audit metadata. */
  note?: string;
}

export interface TriageDecisionOutcome {
  scanFindingId: string;
  newStatus: TriageStatus;
  materialised: MaterialisedFindingInput | null;
  auditMetadata: Record<string, unknown>;
}

export class TriageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TriageError";
  }
}

/**
 * Apply a triage decision. Returns the new status plus, when relevant,
 * the Finding row the caller should insert/link.
 *
 * Rules:
 *   - already-approved findings cannot be re-approved.
 *   - rejected findings can be re-opened by approving — caller must
 *     decide whether to soft-delete the previously materialised Finding;
 *     this helper refuses for safety and surfaces a TriageError.
 *   - deferred findings can transition freely.
 */
export function applyTriageDecision(
  finding: ScanFindingForTriage,
  input: TriageDecisionInput,
): TriageDecisionOutcome {
  if (finding.id !== input.scanFindingId) {
    throw new TriageError("ERR_SCAN_FINDING_MISMATCH", "scan finding id mismatch");
  }
  if (finding.triageStatus === input.decision) {
    throw new TriageError("ERR_TRIAGE_NOOP", `scan finding already in ${input.decision} state`);
  }
  if (input.decision === "approved" && finding.materializedFindingId !== null) {
    throw new TriageError(
      "ERR_TRIAGE_ALREADY_MATERIALISED",
      "scan finding already materialised — cannot re-approve",
    );
  }

  const baseMeta: Record<string, unknown> = {
    fingerprint: finding.fingerprint,
    ruleId: finding.ruleId,
    previousStatus: finding.triageStatus,
    actorId: input.actorId,
    note: input.note ?? null,
  };

  if (input.decision !== "approved") {
    return {
      scanFindingId: finding.id,
      newStatus: input.decision,
      materialised: null,
      auditMetadata: { ...baseMeta, newStatus: input.decision },
    };
  }

  const materialised: MaterialisedFindingInput = {
    projectId: finding.projectId,
    symbolId: finding.symbolId,
    title: finding.title,
    body: finding.body,
    severity: finding.severity,
    category: finding.category,
    evidenceLines: finding.evidenceLines,
    filePath: finding.filePath,
    scanFindingId: finding.id,
    derivation: "inferred",
    confidence: finding.confidence,
  };
  return {
    scanFindingId: finding.id,
    newStatus: "approved",
    materialised,
    auditMetadata: { ...baseMeta, newStatus: "approved", materialised: true },
  };
}

/**
 * Bulk-apply triage decisions. Returns one outcome per input. Any
 * individual failure is captured as `{ ok: false }` so the caller can
 * report partial success without aborting the whole batch.
 */
export function bulkApplyTriage(
  findings: readonly ScanFindingForTriage[],
  decisions: readonly TriageDecisionInput[],
): Array<
  { ok: true; outcome: TriageDecisionOutcome } | { ok: false; scanFindingId: string; error: string }
> {
  const map = new Map(findings.map((f) => [f.id, f]));
  return decisions.map((d) => {
    const finding = map.get(d.scanFindingId);
    if (!finding) {
      return { ok: false, scanFindingId: d.scanFindingId, error: "ERR_SCAN_FINDING_NOT_FOUND" };
    }
    try {
      return { ok: true, outcome: applyTriageDecision(finding, d) };
    } catch (err) {
      const message = err instanceof TriageError ? err.code : (err as Error).message;
      return { ok: false, scanFindingId: d.scanFindingId, error: message };
    }
  });
}
