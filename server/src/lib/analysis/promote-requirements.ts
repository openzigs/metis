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
    if (reviewed) {
      const appended = await appendNewlyApproved({
        analysisId,
        projectId: analysis.projectId,
        toPromote,
        promotedStructuredIds,
      });
      if (appended > 0) return { status: "promoted", requirementCount: appended };
    }
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
    promotionBlocked: {
      blocked: false,
      pendingCount: 0,
      rejectedCount: ticketStatus.rejectedCount,
    },
    promotionStatus: "allowed",
    ...(reviewed ? { promotedStructuredIds } : {}),
  });

  log.info("Promoted withheld requirements", {
    requirements: requirementIds.length,
    analysisId,
  });
  return { status: "promoted", requirementCount: requirementIds.length };
}

function readPromotedStructuredIds(metadata: string | null): string[] | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { promotedStructuredIds?: unknown };
    return Array.isArray(parsed.promotedStructuredIds)
      ? parsed.promotedStructuredIds.filter((x): x is string => typeof x === "string")
      : null;
  } catch {
    return null;
  }
}

const normalizeTitle = (title: string): string => title.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Issue #723 — a rejection can be reopened and approved AFTER the rest of the
 * set was promoted. Replacing the set would discard any review work on the
 * promoted rows, so the newly approved requirement is ADDED instead. Identity
 * is the structured id recorded at promotion; for a set promoted before that
 * record existed, the (reviewed, verbatim) title stands in. A row the user
 * soft-deleted still counts as present, so it is never resurrected.
 *
 * Atomic: the rows and the record of their structured ids commit together in
 * one transaction, so a failure part-way leaves neither behind (a retry would
 * otherwise re-create the rows that did land). The transaction opens with a
 * write to the analysis row, which on Postgres waits for any concurrent append
 * to commit and then returns the metadata it recorded (READ COMMITTED re-reads
 * the row after the wait); on SQLite the write takes the database write lock.
 * Which ids are new is decided only after that, so two approvals resolving at
 * once append each requirement exactly once. (#882's `FOR NO KEY UPDATE`
 * analysis-row lock is the same serialisation point; it is not on `main` yet.)
 */
async function appendNewlyApproved(input: {
  analysisId: string;
  projectId: string;
  toPromote: SynthesisOutput;
  promotedStructuredIds: string[];
}): Promise<number> {
  const flat = await readFlattenedFindings(input.analysisId);

  const requirementIds = await prisma.$transaction(async (tx) => {
    const locked = await tx.analysis.update({
      where: { id: input.analysisId },
      data: { updatedAt: new Date() },
      select: { metadata: true },
    });
    const recorded = readPromotedStructuredIds(locked.metadata);
    let isNew: (idx: number) => boolean;
    if (recorded) {
      const seen = new Set(recorded);
      isNew = (idx) => !seen.has(input.promotedStructuredIds[idx] ?? "");
    } else {
      const rows = await tx.requirement.findMany({
        where: { analysisId: input.analysisId },
        select: { title: true },
      });
      const titles = new Set(rows.map((r) => normalizeTitle(r.title)));
      isNew = (idx) => !titles.has(normalizeTitle(input.toPromote.requirements[idx]?.title ?? ""));
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
        },
        select: { id: true },
      });
      ids.push(row.id);
    }

    // Recorded in the SAME transaction as the rows, onto the metadata read
    // under the lock — never onto a copy taken before it.
    const appendedIds = newIdx.map((i) => input.promotedStructuredIds[i] ?? "").filter(Boolean);
    await tx.analysis.update({
      where: { id: input.analysisId },
      data: {
        metadata: JSON.stringify({
          ...parseMetadataObject(locked.metadata),
          promotedStructuredIds: [
            ...new Set([...(recorded ?? input.promotedStructuredIds), ...appendedIds]),
          ],
        }),
      },
    });
    return ids;
  });
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
