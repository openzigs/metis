/**
 * #1839 (epic #1828) — let a requirement start from a similar requirement's
 * saved code links, with no agent run.
 *
 * #1751 binds this: additive only, and every pick grounded. A borrowed
 * citation is a HYPOTHESIS about this requirement, not grounding, so a copy:
 *
 *   - is written with `source = "similar-requirement"` and the origin
 *     requirement's id (`originRequirementId`), so it is never read as this
 *     requirement's own analysis grounding: the #1759 agent seeder reads only
 *     `analysis-grounding` rows, and the #1754 stored-link channel takes it as
 *     the suggested seed it is;
 *   - carries a confidence capped at {@link BORROWED_CONFIDENCE_CAP}, below the
 *     analysis seeder's {@link DEFAULT_SEED_CONFIDENCE};
 *   - is made only from a link known to be current: `fresh` or `moved`
 *     (#1830, #1831). A `stale` or never-checked (`unverified`) link needs a
 *     re-check first: it is not copied, and is counted in `skippedStale`;
 *   - keeps the origin's code-graph stamp and symbol identity, so the next
 *     re-validation (#1831) checks the copy like any other link. The origin's
 *     `previous*` location is its own history and is not copied;
 *   - is never made from a link that was itself borrowed: a hypothesis is not
 *     lent on. Such a link is counted in `skippedBorrowed` (#1893);
 *   - is read only where it is shown as borrowed (the requirement's chain,
 *     `traceability-spine.ts`) or taken as the suggestion it is (the #1754
 *     stored-link channel). The issue-draft "Related code" section, the
 *     requirements BRD and its reader scope, and the analysis traceability
 *     matrix leave it out (#1893): none of them can say "borrowed".
 *
 * Idempotent: a link whose code (file and symbol) the requirement already
 * holds, under any source, is counted in `skippedDuplicate`, as is any link
 * into a file the requirement's own analysis has grounded: that grounding wins
 * (see {@link hideSupersededBorrowedLinks}, the read-side twin of this rule).
 *
 * A named `mappingIds` entry that matches none of the origin's links is
 * counted in `notFound` (#1893), so the caller can say why nothing was copied.
 *
 * Both requirements are looked up on the project AND the id, so a
 * `fromRequirementId` of another project answers 404 and copies nothing. A
 * requirement cannot borrow from itself (400 `BORROW_FROM_SELF`).
 *
 * The read of what the requirement holds and the write are one serializable
 * transaction (#1893), so two concurrent borrows cannot both copy the same
 * link: the database aborts one, and it is retried against the winner's rows.
 */
import type { PrismaClient } from "@prisma/client";
import {
  BORROW_FROM_SELF_CODE,
  BORROWABLE_FRESHNESS,
  SIMILAR_REQUIREMENT_SOURCE,
  type BorrowCitationsInput,
  type BorrowCitationsResult,
} from "@metis/shared";
import { prisma as defaultPrisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { createChildLogger } from "../logger.js";
import {
  ANALYSIS_GROUNDING_SOURCE,
  DEFAULT_SEED_CONFIDENCE,
} from "./seed-code-links-from-findings.js";

const log = createChildLogger("borrow-citations");

/** The highest confidence a borrowed link carries: below an analysis-seeded one. */
export const BORROWED_CONFIDENCE_CAP = DEFAULT_SEED_CONFIDENCE - 0.1;

type BorrowPrisma = Pick<PrismaClient, "requirement" | "requirementCodeMapping" | "$transaction">;
type BorrowTx = Pick<PrismaClient, "requirementCodeMapping">;

/** Attempts at the borrow's transaction before a serialization failure is surfaced. */
const MAX_ATTEMPTS = 3;

/**
 * A transaction the database aborted on a write conflict: Prisma's `P2034`, or
 * the driver adapter's own error when Postgres refuses the commit (`40001`,
 * measured on `@prisma/adapter-pg`, which surfaces it with no Prisma code).
 */
function isSerializationFailure(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { kind?: unknown } | null } | null;
  return e?.code === "P2034" || e?.cause?.kind === "TransactionWriteConflict";
}

export interface BorrowCitationsDeps {
  prisma?: BorrowPrisma;
}

const codeKey = (filePath: string, codeSymbolId: string | null): string =>
  `${filePath}\u0000${codeSymbolId ?? ""}`;

/**
 * The read-side rule (#1839): a borrowed link into a file the requirement's own
 * analysis has grounded is not shown, so the same code is never listed twice
 * and the requirement's own grounding wins.
 */
export function hideSupersededBorrowedLinks<T extends { source: string; filePath: string }>(
  rows: readonly T[],
): T[] {
  const grounded = new Set(
    rows.filter((r) => r.source === ANALYSIS_GROUNDING_SOURCE).map((r) => r.filePath),
  );
  return rows.filter((r) => r.source !== SIMILAR_REQUIREMENT_SOURCE || !grounded.has(r.filePath));
}

/** Copy `input.fromRequirementId`'s current code links onto `requirementId` as suggestions. */
export async function borrowCitations(
  projectId: string,
  requirementId: string,
  input: BorrowCitationsInput,
  deps?: BorrowCitationsDeps,
): Promise<BorrowCitationsResult> {
  const prisma = deps?.prisma ?? (defaultPrisma as unknown as BorrowPrisma);
  const { fromRequirementId } = input;
  if (requirementId === fromRequirementId) {
    throw new AppError(
      400,
      BORROW_FROM_SELF_CODE,
      "a requirement cannot borrow its own code links",
    );
  }

  const found = await prisma.requirement.findMany({
    where: { id: { in: [requirementId, fromRequirementId] }, projectId, deletedAt: null },
    select: { id: true },
  });
  const foundIds = new Set(found.map((r) => r.id));
  if (!foundIds.has(requirementId) || !foundIds.has(fromRequirementId)) {
    throw new AppError(404, "REQUIREMENT_NOT_FOUND", "requirement not found in this project");
  }

  let result: BorrowCitationsResult | undefined;
  for (let attempt = 1; result === undefined; attempt += 1) {
    try {
      result = await prisma.$transaction(
        (tx) => copyLinks(tx as BorrowTx, projectId, requirementId, input),
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (!isSerializationFailure(error) || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
  log.info("borrowed code links from a similar requirement", {
    projectId,
    requirementId,
    fromRequirementId,
    ...result,
  });
  return result;
}

/** The borrow's read and write, inside its transaction. */
async function copyLinks(
  tx: BorrowTx,
  projectId: string,
  requirementId: string,
  { fromRequirementId, mappingIds }: BorrowCitationsInput,
): Promise<BorrowCitationsResult> {
  const origin = await tx.requirementCodeMapping.findMany({
    where: {
      requirementId: fromRequirementId,
      projectId,
      ...(mappingIds ? { id: { in: mappingIds } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const held = await tx.requirementCodeMapping.findMany({
    where: { requirementId, projectId },
    select: { filePath: true, codeSymbolId: true, source: true },
  });
  const heldKeys = new Set(held.map((h) => codeKey(h.filePath, h.codeSymbolId)));
  const groundedFiles = new Set(
    held.filter((h) => h.source === ANALYSIS_GROUNDING_SOURCE).map((h) => h.filePath),
  );

  const originIds = new Set(origin.map((link) => link.id));
  const result: BorrowCitationsResult = {
    copied: 0,
    skippedStale: 0,
    skippedDuplicate: 0,
    skippedBorrowed: 0,
    notFound: mappingIds ? new Set(mappingIds).size - originIds.size : 0,
  };
  const data = [];
  for (const link of origin) {
    if (link.source === SIMILAR_REQUIREMENT_SOURCE) {
      result.skippedBorrowed += 1;
      continue;
    }
    if (!BORROWABLE_FRESHNESS.has(link.freshness)) {
      result.skippedStale += 1;
      continue;
    }
    const key = codeKey(link.filePath, link.codeSymbolId);
    if (heldKeys.has(key) || groundedFiles.has(link.filePath)) {
      result.skippedDuplicate += 1;
      continue;
    }
    heldKeys.add(key);
    data.push({
      requirementId,
      projectId,
      codeSymbolId: link.codeSymbolId,
      filePath: link.filePath,
      startLine: link.startLine,
      endLine: link.endLine,
      confidence: Math.min(link.confidence, BORROWED_CONFIDENCE_CAP),
      source: SIMILAR_REQUIREMENT_SOURCE,
      originRequirementId: fromRequirementId,
      codeGraphId: link.codeGraphId,
      commitSha: link.commitSha,
      freshness: link.freshness,
      validatedAt: link.validatedAt,
      symbolQualifiedName: link.symbolQualifiedName,
      symbolKind: link.symbolKind,
      symbolContentHash: link.symbolContentHash,
    });
  }
  if (data.length > 0) {
    await tx.requirementCodeMapping.createMany({ data });
    result.copied = data.length;
  }
  return result;
}
