/**
 * Durable clarification dialog state store (Epic #201 / Issue #210).
 *
 * Replaces the prior module-level in-memory `Map` so in-flight clarification
 * survives a server restart. State is checkpointed to the
 * `ClarificationDialogState` Prisma table keyed by `analysisId`; reads
 * rehydrate the JSON blob (interrupt/resume pattern, native Prisma — no
 * external orchestrator).
 *
 * Security: `analysisId` is only ever used as a Prisma `where` value (bound
 * parameter), never string-interpolated into SQL, so it cannot be used for
 * injection. The serialized payload is JSON and is parsed defensively.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { isUniqueViolation } from "../db/prisma-errors.js";
import type { ClarificationState } from "./types/requirements.js";

const log = createChildLogger("clarification-dialog-store");

/**
 * Read the durable dialog state for an analysis, or `undefined` when none has
 * been checkpointed (or the stored blob is unparseable).
 */
export async function readDialogState(analysisId: string): Promise<ClarificationState | undefined> {
  return (await readDialogStateRevision(analysisId))?.state;
}

/**
 * Upsert the durable dialog state for an analysis. Idempotent: repeated writes
 * with the same `analysisId` overwrite the prior checkpoint.
 */
export async function writeDialogState(
  analysisId: string,
  state: ClarificationState,
): Promise<void> {
  const serialized = JSON.stringify(state);
  await prisma.clarificationDialogState.upsert({
    where: { analysisId },
    create: { analysisId, state: serialized },
    update: { state: serialized },
  });
}

/**
 * #2101 — the stored state as read, with the exact serialized row it came
 * from: the revision a later {@link replaceDialogState} compares against.
 */
export interface DialogStateRevision {
  state: ClarificationState;
  revision: string;
}

/**
 * #2101 — read the state together with its revision, for a caller that will
 * write it back with {@link replaceDialogState}. `undefined` as
 * {@link readDialogState} is.
 */
export async function readDialogStateRevision(
  analysisId: string,
): Promise<DialogStateRevision | undefined> {
  const row = await prisma.clarificationDialogState.findUnique({
    where: { analysisId },
    select: { state: true },
  });
  if (!row) return undefined;
  try {
    return { state: JSON.parse(row.state) as ClarificationState, revision: row.state };
  } catch {
    log.warn("Corrupt clarification dialog state — ignoring", { analysisId });
    return undefined;
  }
}

/**
 * #2101 — compare-and-set: write `state` only while the row still holds
 * `revision`, in one conditional UPDATE, so two writers that read the same
 * revision cannot both succeed. Returns the new revision, or `null` when the
 * row changed (or is gone) since it was read, and nothing was written.
 *
 * #2142 — `revision` `undefined` is a writer that read no row: the state is
 * created only while there is still none, and `null` when another writer
 * created it first. `client` is the transaction to write in, if any.
 */
export async function replaceDialogState(
  analysisId: string,
  revision: string | undefined,
  state: ClarificationState,
  client: Prisma.TransactionClient = prisma,
): Promise<string | null> {
  const serialized = JSON.stringify(state);
  if (revision === undefined) {
    // A writer that read no state may have read a row that will not parse
    // (readDialogStateRevision ignores it). Creating would then collide with
    // that row forever, so compare-and-set over its raw text instead: the
    // corrupt row is replaced, as the old unconditional upsert replaced it.
    // Read first rather than catching the create's unique violation, which
    // would abort an enclosing Postgres transaction.
    const existing = await client.clarificationDialogState.findUnique({
      where: { analysisId },
      select: { state: true },
    });
    if (existing) {
      if (parses(existing.state)) return null;
      const { count } = await client.clarificationDialogState.updateMany({
        where: { analysisId, state: existing.state },
        data: { state: serialized },
      });
      return count === 1 ? serialized : null;
    }
    try {
      await client.clarificationDialogState.create({ data: { analysisId, state: serialized } });
      return serialized;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }
  const { count } = await client.clarificationDialogState.updateMany({
    where: { analysisId, state: revision },
    data: { state: serialized },
  });
  return count === 1 ? serialized : null;
}

/**
 * #2142 — {@link replaceDialogState} and the writes that belong with it, in one
 * transaction: `alongside` runs only once the compare-and-set has landed, and
 * when it throws, the state write is rolled back with it and the error
 * rethrown. So a submit's round and its refined requirements are committed
 * together or not at all — a refused or crashed submit never consumes the
 * round, and no restore write is needed (#2101's could itself be overwritten).
 * Returns the new revision, or `null` when the compare-and-set found the row
 * changed, and neither it nor `alongside` wrote anything.
 */
export async function commitDialogState(
  analysisId: string,
  revision: string,
  state: ClarificationState,
  alongside: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const committed = await replaceDialogState(analysisId, revision, state, tx);
    if (committed !== null) await alongside(tx);
    return committed;
  });
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Delete the durable dialog state for an analysis (no-op when absent). */
export async function deleteDialogState(analysisId: string): Promise<void> {
  await prisma.clarificationDialogState.deleteMany({ where: { analysisId } });
}
