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
  CHECKPOINT_APPROVED_IDS_KEY,
  getStructuredRequirements,
  lockRequirementSet,
  persistAnalysisEnhancement,
  persistRequirements,
  readFlattenedFindings,
} from "./analysis-service.js";
import { canCreateTickets } from "./approval-checkpoint.js";
import {
  buildApprovedRequirementSet,
  latestRequirementApprovals,
} from "./approved-requirement-set.js";
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
    select: { projectId: true, metadata: true },
  });
  if (!analysis) {
    return { status: "unavailable", reason: "Analysis not found." };
  }

  const synthesis = await readSynthesisOutput(analysisId);

  // Issue #730 — when the requirements went through the approval checkpoint,
  // the reviewed list is the STRUCTURED one (one `requirement` approval per
  // structured requirement). Promote that list, not the synthesis output, which
  // is a different set (and on a degraded run, finding-titled fallback rows).
  const structuredList = await getStructuredRequirements(analysisId);
  const structured = structuredList?.requirements ?? [];
  // Issue #909 — the extraction run this list came from (null before #909).
  const structuredRunId = structuredList?.runId ?? null;
  const approvalRows =
    structured.length > 0
      ? await prisma.approvalRequest.findMany({
          where: { analysisId, type: "requirement" },
          select: { itemId: true, status: true, createdAt: true, reviewedAt: true },
        })
      : [];
  // Issue #909 — one deciding approval per id: the current run's, never an
  // earlier run's verdict on a different requirement that shared its id.
  const requirementApprovals = [...latestRequirementApprovals(approvalRows).values()];
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

  const approvedIds = new Set(
    requirementApprovals.filter((a) => a.status === "approved").map((a) => a.itemId),
  );
  const toPromote: SynthesisOutput = reviewed
    ? buildApprovedRequirementSet({ structured, approvedIds, synthesis })
    : (synthesis as SynthesisOutput);
  // Parallel to `toPromote.requirements` on the reviewed path (same filter, same order).
  const promotedStructuredIds = reviewed
    ? structured.filter((r) => approvedIds.has(r.id)).map((r) => r.id)
    : [];

  // Idempotence: `persistRequirements` REPLACES the set (#57), so a second call
  // would silently discard any human edits made after the first promotion.
  const existing = await prisma.requirement.count({ where: { analysisId } });
  if (existing > 0) {
    if (!reviewed) return { status: "already-promoted", requirementCount: existing };
    // Issue #909 — the persisted set came from a DIFFERENT extraction run: this
    // list is a re-synthesis, not a reopened rejection. Its ids say nothing
    // about which rows exist, so appending would put a second set beside the
    // reviewed one. Replace instead, as the orchestrator does for a re-run —
    // `persistRequirements` withholds that replacement when it would destroy
    // review work (#769).
    if (readPromotionRecord(analysis.metadata).runId === structuredRunId) {
      const approvedAt = new Map(
        requirementApprovals
          .filter((a) => a.status === "approved")
          .map((a) => [a.itemId, a.reviewedAt ?? null] as const),
      );
      const appended = await appendNewlyApproved({
        analysisId,
        projectId: analysis.projectId,
        toPromote,
        promotedStructuredIds,
        structuredRunId,
        approvedAt,
      });
      if (appended === "superseded") return { status: "unavailable", reason: SUPERSEDED_REASON };
      if (appended > 0) return { status: "promoted", requirementCount: appended };
      return { status: "already-promoted", requirementCount: existing };
    }
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

  let withheld = false;
  const requirementIds = await persistRequirements({
    analysisId,
    projectId: analysis.projectId,
    synthesis: toPromote,
    findingIdsByIndex,
    coverages,
    verdicts,
    onWithheld: () => {
      withheld = true;
    },
    // Issue #939 — the user approved each of these in the checkpoint; asking
    // for a second Approve per requirement on the hub was the bug.
    ...(reviewed ? { reviewStatus: "approved" as const } : {}),
  });
  // #769 — the replacement was refused to protect review work on the existing
  // set; nothing was written, so nothing is recorded as promoted.
  if (withheld) return { status: "unavailable", reason: WITHHELD_REASON };

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
    promotionBlocked: {
      blocked: false,
      pendingCount: 0,
      rejectedCount: ticketStatus.rejectedCount,
    },
    promotionStatus: "allowed",
    ...(reviewed ? { promotedStructuredIds, promotedStructuredRunId: structuredRunId } : {}),
  });

  log.info("Promoted withheld requirements", {
    requirements: requirementIds.length,
    analysisId,
  });
  return { status: "promoted", requirementCount: requirementIds.length };
}

/**
 * Which structured ids are rows, and the extraction run they belong to. `ids`
 * is null for a set promoted before #723 recorded them; `runId` is null for a
 * record (or a list) written before #909.
 */
function readPromotionRecord(metadata: string | null | undefined): {
  ids: string[] | null;
  runId: string | null;
} {
  const parsed = parseMetadataObject(metadata ?? null);
  const ids = Array.isArray(parsed.promotedStructuredIds)
    ? parsed.promotedStructuredIds.filter((x): x is string => typeof x === "string")
    : null;
  const runId =
    typeof parsed.promotedStructuredRunId === "string" ? parsed.promotedStructuredRunId : null;
  return { ids, runId };
}

/**
 * Issue #723 — a rejection can be reopened and approved AFTER the rest of the
 * set was promoted. Replacing the set would discard any review work on the
 * promoted rows, so the newly approved requirement is ADDED instead. Identity
 * is the structured id recorded at promotion, scoped to the extraction run
 * (#909); for a set promoted before that record existed, an approval made after
 * the set was first promoted marks the new ones (#909 — a title match duplicated
 * edited rows). A row the user soft-deleted still counts as present, so it is
 * never resurrected.
 *
 * Atomic: the rows and the record of their structured ids commit together in
 * one transaction, so a failure part-way leaves neither behind (a retry would
 * otherwise re-create the rows that did land). On Postgres the transaction
 * opens with {@link lockRequirementSet} — the analysis row `FOR NO KEY UPDATE`,
 * then the requirement rows `FOR UPDATE`, the same locks in the same order as
 * `persistRequirements` (#882) — so a concurrent append or replacement of this
 * set waits for it. The write to the analysis row that follows returns the
 * metadata recorded by whichever transaction held the lock before (READ
 * COMMITTED reads the latest committed row); on SQLite that write takes the
 * database write lock. Which ids are new is decided only after that, so two
 * approvals resolving at once append each requirement exactly once.
 */
const SUPERSEDED_REASON =
  "The requirement set was replaced by another run while you were approving. Reload the analysis and review the new list.";
const WITHHELD_REASON =
  "These approvals are for a newer extraction run, but replacing the existing requirements was withheld to protect review work already done on them. Nothing was promoted.";

async function appendNewlyApproved(input: {
  analysisId: string;
  projectId: string;
  toPromote: SynthesisOutput;
  promotedStructuredIds: string[];
  structuredRunId: string | null;
  /** When each approved structured id was approved (its deciding approval). */
  approvedAt: ReadonlyMap<string, Date | null>;
}): Promise<number | "superseded"> {
  const flat = await readFlattenedFindings(input.analysisId);
  let superseded = false;

  const requirementIds = await prisma.$transaction(async (tx) => {
    await lockRequirementSet(tx, input.analysisId);
    const locked = await tx.analysis.update({
      where: { id: input.analysisId },
      data: { updatedAt: new Date() },
      select: { metadata: true },
    });
    const record = readPromotionRecord(locked.metadata);
    // #909 — re-checked under the lock: a replacement for another run may have
    // committed since the caller routed here.
    if (record.runId !== input.structuredRunId) {
      superseded = true;
      return [];
    }
    const recorded = record.ids;
    let isNew: (idx: number) => boolean;
    if (recorded) {
      const seen = new Set(recorded);
      isNew = (idx) => !seen.has(input.promotedStructuredIds[idx] ?? "");
    } else {
      // Issue #909 — a set promoted before the ids were recorded. Matching on
      // title duplicated any row whose title was edited after promotion. A
      // requirement in that set was approved BEFORE the set was first
      // promoted; one approved after it (reopened, then approved) is new.
      const first = await tx.requirement.findFirst({
        where: { analysisId: input.analysisId },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      });
      const promotedAt = first?.createdAt.getTime() ?? Number.POSITIVE_INFINITY;
      isNew = (idx) => {
        const at = input.approvedAt.get(input.promotedStructuredIds[idx] ?? "");
        return at != null && at.getTime() > promotedAt;
      };
    }
    const newIdx = input.toPromote.requirements.map((_, i) => i).filter(isNew);
    if (newIdx.length === 0) return [];

    const added = newIdx.map((i) => input.toPromote.requirements[i]!);
    const coverages = computeCoverageForRequirements(
      added,
      flat.map((f) => ({ citations: f.citations })),
    );
    const verdicts = computeVerdictsForRequirements(
      added,
      flat.map((f) => ({ agentKey: f.agentKey, verdict: f.verdict ?? null })),
      flat.some((f) => f.agentKey === "code"),
    );

    // Same row shape `persistRequirements` writes, without its replace semantics.
    const ids: string[] = [];
    for (let k = 0; k < added.length; k++) {
      const r = added[k]!;
      const evidenceIds = r.evidenceFindingIndexes
        .map((i) => flat[i]?.findingId)
        .filter((id): id is string => Boolean(id));
      const row = await tx.requirement.create({
        data: {
          analysisId: input.analysisId,
          projectId: input.projectId,
          type: r.type,
          title: r.title.slice(0, 255),
          body: r.body,
          priority: r.priority,
          labels: JSON.stringify(
            Array.from(new Set([...r.labels, ...evidenceIds.map((id) => `finding:${id}`)])),
          ),
          acceptanceCriteria: JSON.stringify(r.acceptanceCriteria ?? []),
          storyPoints: r.storyPoints ?? null,
          coverage: coverages[k] ?? null,
          verdict: verdicts[k] ?? null,
          // Issue #939 — approved in the checkpoint, as on the first promotion.
          reviewStatus: "approved",
        },
        select: { id: true },
      });
      ids.push(row.id);
    }

    // Recorded in the SAME transaction as the rows, onto the metadata read
    // under the lock — never onto a copy taken before it.
    const appendedIds = newIdx.map((i) => input.promotedStructuredIds[i] ?? "").filter(Boolean);
    const lockedMetadata = parseMetadataObject(locked.metadata);
    const checkpointApproved = Array.isArray(lockedMetadata[CHECKPOINT_APPROVED_IDS_KEY])
      ? (lockedMetadata[CHECKPOINT_APPROVED_IDS_KEY] as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
      : [];
    await tx.analysis.update({
      where: { id: input.analysisId },
      data: {
        metadata: JSON.stringify({
          ...lockedMetadata,
          [CHECKPOINT_APPROVED_IDS_KEY]: [...checkpointApproved, ...ids],
          promotedStructuredIds: [
            ...new Set([...(recorded ?? input.promotedStructuredIds), ...appendedIds]),
          ],
          promotedStructuredRunId: input.structuredRunId,
        }),
      },
    });
    return ids;
  });
  if (superseded) return "superseded";
  if (requirementIds.length === 0) return 0;

  // Best-effort enrichment of the committed rows, as on the first promotion.
  await applyClarificationsToRequirements(input.analysisId);
  try {
    await seedRequirementCodeLinksFromFindings({
      analysisId: input.analysisId,
      projectId: input.projectId,
      requirementIds,
    });
  } catch (err) {
    log.warn("requirement→code link seeding failed after appending (non-fatal)", {
      analysisId: input.analysisId,
      error: (err as Error).message,
    });
  }

  log.info("Appended requirements approved after promotion", {
    analysisId: input.analysisId,
    requirements: requirementIds.length,
  });
  return requirementIds.length;
}

function parseMetadataObject(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
