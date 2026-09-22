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
  const row = await prisma.clarificationDialogState.findUnique({
    where: { analysisId },
    select: { state: true },
  });
  if (!row) return undefined;
  try {
    return JSON.parse(row.state) as ClarificationState;
  } catch {
    log.warn("Corrupt clarification dialog state — ignoring", { analysisId });
    return undefined;
  }
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

/** Delete the durable dialog state for an analysis (no-op when absent). */
export async function deleteDialogState(analysisId: string): Promise<void> {
  await prisma.clarificationDialogState.deleteMany({ where: { analysisId } });
}
