/**
 * Issue #1104 (finding B) — release the requirements the approval gate withheld.
 *
 * Epic #202 (#216) made `runSynthesisAndPersist` stop before `persistRequirements`
 * whenever an approval request was still pending. That gate was correct, but it
 * was a one-way door: nothing ever retried the promotion, so resolving every
 * approval left the analysis permanently showing "No requirements yet" while the
 * synthesis output sat unread in its `AgentResult` row.
 *
 * This module is that retry. It is deliberately pure-ish and idempotent: it
 * re-derives the same deterministic inputs the orchestrator computed
 * (coverage #736, verdicts #773) from already-persisted data, performs no LLM
 * call, and refuses to run twice.
 */
import { synthesisOutputSchema, type SynthesisOutput } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { seedRequirementCodeLinksFromFindings } from "../traceability/seed-code-links-from-findings.js";
import {
  getStructuredRequirements,
  persistAnalysisEnhancement,
  persistRequirements,
  readFlattenedFindings,
} from "./analysis-service.js";
import { canCreateTickets } from "./approval-checkpoint.js";
import { buildApprovedRequirementSet } from "./approved-requirement-set.js";
import { applyClarificationsToRequirements } from "./clarification-enrichment.js";
import { describePromotionGate } from "./promotion-gate.js";
import { computeCoverageForRequirements } from "./requirement-coverage.js";
import { computeVerdictsForRequirements, type VerdictFindingInput } from "./requirement-verdict.js";

const log = createChildLogger("promote-requirements");

export type PromotionOutcome =
  /** The withheld requirements are now durable `Requirement` rows. */
  | { status: "promoted"; requirementCount: number }
  /** Approvals are still outstanding — nothing was persisted. */
  | {
      status: "blocked";
      pendingCount: number;
      rejectedCount: number;
      awaitingRequirementCount: number;
      reason: string;
    }
  /** Requirements already exist for this analysis; this is a no-op. */
  | { status: "already-promoted"; requirementCount: number }
  /** Nothing to promote (no analysis / no usable synthesis output). */
  | { status: "unavailable"; reason: string };

/** Read + validate the synthesis agent's persisted output for an analysis. */
async function readSynthesisOutput(analysisId: string): Promise<SynthesisOutput | null> {
  const row = await prisma.agentResult.findFirst({
    where: { analysisId, agentKey: "synthesis", status: "completed" },
    select: { output: true },
    orderBy: { startedAt: "desc" },
  });
  if (!row?.output) return null;
  try {
    const parsed = typeof row.output === "string" ? JSON.parse(row.output) : row.output;
    // #774 rides `toolTelemetry` alongside the agent output's own keys; the
    // schema is strict about nothing else, so parse the object as-is.
    const validation = synthesisOutputSchema.safeParse(parsed);
    return validation.success ? validation.data : null;
  } catch {
    return null;
  }
}

/**
 * Promote an analysis's synthesized requirements into durable rows, provided
 * every approval checkpoint is resolved. Never throws for an expected state —
 * each outcome is reported so the caller can tell the user exactly where the
 * work is.
 */
export async function promoteApprovedRequirements(analysisId: string): Promise<PromotionOutcome> {
  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId },
    select: { projectId: true },
  });
  if (!analysis) {
    return { status: "unavailable", reason: "Analysis not found." };
  }

  const synthesis = await readSynthesisOutput(analysisId);

  // Issue #730 — when the requirements went through the approval checkpoint,
  // the reviewed list is the STRUCTURED one (one `requirement` approval per
  // structured requirement). Promote that list, not the synthesis output, which
  // is a different set (and on a degraded run, finding-titled fallback rows).
  const structured = (await getStructuredRequirements(analysisId))?.requirements ?? [];
  const requirementApprovals =
    structured.length > 0
      ? await prisma.approvalRequest.findMany({
          where: { analysisId, type: "requirement" },
          select: { itemId: true, status: true },
        })
      : [];
  const reviewed = requirementApprovals.length > 0;

  if (!synthesis && !reviewed) {
    return {
      status: "unavailable",
      reason: "This analysis has no usable synthesis output to promote.",
    };
  }

  const ticketStatus = await canCreateTickets(analysisId);
  if (!ticketStatus.allowed) {
    const awaitingRequirementCount = reviewed
      ? new Set(requirementApprovals.filter((a) => a.status !== "rejected").map((a) => a.itemId))
          .size
      : (synthesis?.requirements.length ?? 0);
    const { reason } = describePromotionGate({
      pendingCount: ticketStatus.pendingCount,
      rejectedCount: ticketStatus.rejectedCount,
      awaitingRequirementCount,
    });
    return {
      status: "blocked",
      pendingCount: ticketStatus.pendingCount,
      rejectedCount: ticketStatus.rejectedCount,
      awaitingRequirementCount,
      reason,
    };
  }

  const toPromote: SynthesisOutput = reviewed
    ? buildApprovedRequirementSet({
        structured,
        approvedIds: new Set(
          requirementApprovals.filter((a) => a.status === "approved").map((a) => a.itemId),
        ),
        synthesis,
      })
    : (synthesis as SynthesisOutput);

  // Idempotence: `persistRequirements` REPLACES the set (#57), so a second call
  // would silently discard any human edits made after the first promotion.
  const existing = await prisma.requirement.count({ where: { analysisId } });
  if (existing > 0) {
    return { status: "already-promoted", requirementCount: existing };
  }

  const flat = await readFlattenedFindings(analysisId);
  const findingIdsByIndex = flat.map((f) => f.findingId);
  const coverages = computeCoverageForRequirements(
    toPromote.requirements,
    flat.map((f) => ({ citations: f.citations })),
  );
  const verdictFindings: VerdictFindingInput[] = flat.map((f) => ({
    agentKey: f.agentKey,
    verdict: f.verdict ?? null,
  }));
  const verdicts = computeVerdictsForRequirements(
    toPromote.requirements,
    verdictFindings,
    flat.some((f) => f.agentKey === "code"),
  );

  const requirementIds = await persistRequirements({
    analysisId,
    projectId: analysis.projectId,
    synthesis: toPromote,
    findingIdsByIndex,
    coverages,
    verdicts,
  });

  // Issue #1116 — the rows only exist NOW, so this is the first moment the
  // clarification answers the user submitted while the gate was closed can be
  // written into them. Without this the whole clarify round reaches the approval
  // view and stops there: the drafts (and the GitHub issues they become) replay
  // the pre-clarification synthesis output. Best-effort inside.
  await applyClarificationsToRequirements(analysisId);

  // Same best-effort enrichment the orchestrator's happy path performs.
  try {
    await seedRequirementCodeLinksFromFindings({
      analysisId,
      projectId: analysis.projectId,
      requirementIds,
    });
  } catch (err) {
    log.warn("requirement→code link seeding failed after promotion (non-fatal)", {
      analysisId,
      error: (err as Error).message,
    });
  }

  await persistAnalysisEnhancement(analysisId, {
    promotionBlocked: { blocked: false, pendingCount: 0, rejectedCount: 0 },
    promotionStatus: "allowed",
  });

  log.info("Promoted withheld requirements", {
    requirements: requirementIds.length,
    analysisId,
  });
  return { status: "promoted", requirementCount: requirementIds.length };
}
