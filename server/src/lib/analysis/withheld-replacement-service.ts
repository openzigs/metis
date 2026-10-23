/**
 * Issue #780 — read, apply and dismiss a withheld re-synthesis.
 *
 * The rules are in `withheld-replacement.ts`; this module reads the rows and
 * writes the outcome. Apply runs as ONE interactive transaction with the set
 * locked the way a replacement locks it (#779), and re-reads which rows carry
 * review work inside it: work committed after the analyst looked at the
 * comparison only ever moves a row from "replace" to "keep" or "update".
 */
import type { WithheldReplacementApplyResult, WithheldReplacementDiff } from "@metis/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import {
  CHECKPOINT_APPROVED_IDS_KEY,
  lockAnalysisRow,
  lockRequirementSet,
  parseMetadata,
  readCheckpointApprovedIds,
  reviewedRequirementWhere,
} from "./analysis-service.js";
import { CRITERIA_PROPOSALS_KEY, readCriteriaProposals } from "./approved-criteria-carry-over.js";
import {
  APPLIED_WITHHELD_REPLACEMENT_REASON,
  WITHHELD_PROPOSAL_KEY,
  diffWithheldReplacement,
  fieldChanges,
  planWithheldApply,
  readWithheldProposal,
  readWithheldRecord,
  type CurrentRequirementRow,
  type WithheldProposal,
  type WithheldProposalRow,
} from "./withheld-replacement.js";
import {
  updateRequirementWithHistoryInTransaction,
  type VersionPrismaClient,
} from "../requirements/requirement-version-service.js";
import { noteProjectRequirementsChanged } from "../docs-gen/approved-requirements-staleness.js";
import { seedRequirementCodeLinksFromFindings } from "../traceability/seed-code-links-from-findings.js";
import { applyClarificationsToRequirements } from "./clarification-enrichment.js";

const log = createChildLogger("withheld-replacement");

/** Upper bound on the apply transaction, as for a replacement. */
const APPLY_TIMEOUT_MS = 60_000;

/** Why a withheld re-synthesis could not be answered. */
export class WithheldReplacementError extends Error {
  readonly code: "NO_PROPOSAL" | "STALE";
  constructor(code: "NO_PROPOSAL" | "STALE", message: string) {
    super(message);
    this.name = "WithheldReplacementError";
    this.code = code;
  }
}

const NO_PROPOSAL_MESSAGE = "There is no withheld re-synthesis to review on this analysis";
const STALE_MESSAGE =
  "A newer re-synthesis replaced the one you reviewed. Reload to see the current changes.";

/** The refusal and its stored result, when both exist and belong together. */
function readPair(metadata: Record<string, unknown>) {
  const withheld = readWithheldRecord(metadata);
  const proposal = readWithheldProposal(metadata);
  if (!withheld || !proposal || proposal.at !== withheld.at) return null;
  return { withheld, proposal };
}

async function readCurrentRows(
  tx: Prisma.TransactionClient,
  analysisId: string,
  metadata: Record<string, unknown>,
): Promise<CurrentRequirementRow[]> {
  const rows = await tx.requirement.findMany({
    where: { analysisId },
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      priority: true,
      acceptanceCriteria: true,
      reviewStatus: true,
      deletedAt: true,
      promotedStructuredId: true,
      promotedStructuredRunId: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const reviewed = await tx.requirement.findMany({
    where: reviewedRequirementWhere(analysisId, readCheckpointApprovedIds(metadata)),
    select: { id: true },
  });
  const reviewedIds = new Set(reviewed.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    priority: r.priority,
    acceptanceCriteria: r.acceptanceCriteria,
    reviewStatus: r.reviewStatus,
    reviewed: reviewedIds.has(r.id),
    deleted: r.deletedAt !== null,
    promotedStructuredId: r.promotedStructuredId,
    promotedStructuredRunId: r.promotedStructuredRunId,
  }));
}

/**
 * The comparison of the current set with the withheld one, or null when the
 * analysis has none to review (never withheld, answered, or recorded before
 * #780 kept the result).
 */
export async function getWithheldReplacementDiff(
  analysisId: string,
): Promise<WithheldReplacementDiff | null> {
  return prisma.$transaction(async (tx) => {
    const analysis = await tx.analysis.findFirst({
      where: { id: analysisId },
      select: { metadata: true },
    });
    const metadata = parseMetadata(analysis?.metadata ?? null);
    const pair = readPair(metadata);
    if (!pair) return null;
    const current = await readCurrentRows(tx, analysisId, metadata);
    return diffWithheldReplacement(pair.withheld, current, pair.proposal.rows);
  });
}

/** Read the pair under lock and check it is the one the analyst answered. */
function requirePair(metadata: Record<string, unknown>, at: string) {
  const pair = readPair(metadata);
  if (!pair) throw new WithheldReplacementError("NO_PROPOSAL", NO_PROPOSAL_MESSAGE);
  if (pair.withheld.at !== at) throw new WithheldReplacementError("STALE", STALE_MESSAGE);
  return pair;
}

function withoutWithheld(metadata: Record<string, unknown>): Record<string, unknown> {
  const next = { ...metadata };
  delete next.requirementReplacementWithheld;
  delete next[WITHHELD_PROPOSAL_KEY];
  return next;
}

export interface ApplyWithheldReplacementOutcome extends WithheldReplacementApplyResult {
  insertedIds: string[];
}

/**
 * Apply the withheld re-synthesis `at` names. See `planWithheldApply` for what
 * happens to each requirement; nothing with review work is deleted.
 */
export async function applyWithheldReplacement(input: {
  analysisId: string;
  projectId: string;
  actorId: string;
  at: string;
}): Promise<ApplyWithheldReplacementOutcome> {
  let proposal: WithheldProposal | null = null;
  const outcome = await prisma.$transaction(
    async (tx) => {
      await lockRequirementSet(tx, input.analysisId);
      const analysis = await tx.analysis.findFirst({
        where: { id: input.analysisId },
        select: { metadata: true },
      });
      const metadata = parseMetadata(analysis?.metadata ?? null);
      const pair = requirePair(metadata, input.at);
      proposal = pair.proposal;
      const current = await readCurrentRows(tx, input.analysisId, metadata);
      const steps = planWithheldApply(current, pair.proposal.rows);

      const result: ApplyWithheldReplacementOutcome = {
        added: 0,
        replaced: 0,
        updated: 0,
        deleted: 0,
        kept: 0,
        insertedIds: [],
      };
      // Unreviewed rows go first, as a re-run deletes them (#57).
      const deleteIds = steps.flatMap((s) =>
        s.kind === "delete" || s.kind === "replace" ? [s.current.id] : [],
      );
      if (deleteIds.length > 0) {
        await tx.requirement.deleteMany({
          where: { analysisId: input.analysisId, id: { in: deleteIds } },
        });
      }
      const deleted = new Set(deleteIds);
      for (const step of steps) {
        if (step.kind === "keep") {
          result.kept++;
        } else if (step.kind === "delete") {
          result.deleted++;
        } else if (step.kind === "update") {
          if (await updateReviewed(tx, step.current, step.proposed, input.actorId)) {
            result.updated++;
          }
        } else {
          const row = await tx.requirement.create({
            data: {
              ...step.proposed,
              analysisId: input.analysisId,
              projectId: input.projectId,
              ...(pair.proposal.reviewStatus ? { reviewStatus: pair.proposal.reviewStatus } : {}),
            },
            select: { id: true },
          });
          result.insertedIds.push(row.id);
          if (step.kind === "insert") result.added++;
          else if (step.changed) result.replaced++;
        }
      }

      const next = withoutWithheld(metadata);
      // #1389 — suggestions for rows deleted here go with them.
      const proposals = readCriteriaProposals(next);
      for (const id of Object.keys(proposals)) if (deleted.has(id)) delete proposals[id];
      if (Object.keys(proposals).length > 0) next[CRITERIA_PROPOSALS_KEY] = proposals;
      else delete next[CRITERIA_PROPOSALS_KEY];
      // #939 — the checkpoint-approved rows are the surviving ones plus, for an
      // approved set, the rows inserted here.
      const approvedIds = readCheckpointApprovedIds(next).filter((id) => !deleted.has(id));
      if (pair.proposal.reviewStatus) approvedIds.push(...result.insertedIds);
      if (approvedIds.length > 0) next[CHECKPOINT_APPROVED_IDS_KEY] = approvedIds;
      else delete next[CHECKPOINT_APPROVED_IDS_KEY];
      // The applied rows came from a synthesis of this health (#769, #1117).
      if (pair.proposal.degraded) next.synthesisDegraded = pair.proposal.degraded;
      else delete next.synthesisDegraded;
      await tx.analysis.update({
        where: { id: input.analysisId },
        data: { metadata: JSON.stringify(next) },
      });
      return result;
    },
    { timeout: APPLY_TIMEOUT_MS },
  );

  // Committed by now. Each follow-up is best-effort, as after a replacement.
  void noteProjectRequirementsChanged(input.projectId);
  await bestEffort("code-link seeding", () =>
    seedRequirementCodeLinksFromFindings({
      analysisId: input.analysisId,
      projectId: input.projectId,
      requirementIds: outcome.insertedIds,
    }),
  );
  const promoted = (proposal as WithheldProposal | null)?.rows.some((r) => r.promotedStructuredId);
  if (promoted && outcome.insertedIds.length > 0) {
    await bestEffort("clarification re-application", () =>
      applyClarificationsToRequirements(input.analysisId),
    );
  }
  return outcome;
}

/**
 * Write the fields a reviewed requirement's restatement changes, as one
 * version with the analyst as author. Only the fields that differ, so an
 * unchanged one is not rewritten. Returns whether anything changed.
 */
async function updateReviewed(
  tx: Prisma.TransactionClient,
  current: CurrentRequirementRow,
  proposed: WithheldProposalRow,
  actorId: string,
): Promise<boolean> {
  const patch: Record<string, string> = {};
  for (const c of fieldChanges(current, proposed)) {
    if (c.field === "description") patch.body = proposed.body;
    else patch[c.field] = proposed[c.field];
  }
  if (Object.keys(patch).length === 0) return false;
  const written = await updateRequirementWithHistoryInTransaction(
    tx as unknown as Pick<VersionPrismaClient, "requirement" | "requirementVersion">,
    {
      requirementId: current.id,
      patch,
      actorId,
      reason: APPLIED_WITHHELD_REPLACEMENT_REASON,
    },
  );
  return written.changed;
}

async function bestEffort(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn(`Applying a withheld re-synthesis: ${what} failed (non-fatal)`, {
      error: String(err),
    });
  }
}

/**
 * Dismiss the withheld re-synthesis `at` names: the current set stays exactly
 * as it is, and the stored result and the notice are cleared. Returns how many
 * proposed requirements were discarded.
 */
export async function dismissWithheldReplacement(input: {
  analysisId: string;
  at: string;
}): Promise<{ discarded: number }> {
  return prisma.$transaction(async (tx) => {
    await lockAnalysisRow(tx, input.analysisId);
    const analysis = await tx.analysis.findFirst({
      where: { id: input.analysisId },
      select: { metadata: true },
    });
    const metadata = parseMetadata(analysis?.metadata ?? null);
    const pair = requirePair(metadata, input.at);
    await tx.analysis.update({
      where: { id: input.analysisId },
      data: { metadata: JSON.stringify(withoutWithheld(metadata)) },
    });
    return { discarded: pair.proposal.rows.length };
  });
}
