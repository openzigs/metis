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
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
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
 */
export async function replaceDialogState(
  analysisId: string,
  revision: string,
  state: ClarificationState,
): Promise<string | null> {
  const serialized = JSON.stringify(state);
  const { count } = await prisma.clarificationDialogState.updateMany({
    where: { analysisId, state: revision },
    data: { state: serialized },
  });
  return count === 1 ? serialized : null;
}

/** Delete the durable dialog state for an analysis (no-op when absent). */
export async function deleteDialogState(analysisId: string): Promise<void> {
  await prisma.clarificationDialogState.deleteMany({ where: { analysisId } });
}
