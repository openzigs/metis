/**
 * #50 — documentation generations interrupted by a process exit.
 *
 * Generation runs in-process (`generateDocumentAsync`, fire-and-forget from the
 * request), not as a scheduler task, so the scheduler's durable-task recovery
 * never sees it: a restart, crash, deploy or dev hot-reload left the row
 * `generating` forever.
 *
 * A running generation now heartbeats its row (`updatedAt`) while it holds its
 * claim. A sweep — once at startup, then every minute — fails any row whose
 * heartbeat has stopped, with {@link GENERATION_INTERRUPTED_MESSAGE}, and the
 * user regenerates it in one click (`POST /docs/:docId/regenerate`). Keying on
 * the heartbeat rather than on "this process just started" keeps the sweep safe
 * with more than one replica: another replica's live run keeps its row fresh.
 *
 * Deliberately NOT resumed automatically: a restarted server would otherwise
 * spend model tokens nobody asked for again, and the scheduler that could own
 * it can be disabled. Regenerating reuses the Phase-1 fact cache, so modules
 * already extracted before the interruption are not paid for twice.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { jobEvents } from "../socket/job-events.js";

const log = createChildLogger("docs-gen-interrupted");

/** How often a running generation refreshes its row. */
export const GENERATION_HEARTBEAT_MS = 60_000;
/**
 * A `generating` row whose heartbeat is older than this has no live process.
 * Five missed beats, so a long synchronous stretch or a slow write never fails
 * a live run.
 */
export const GENERATING_STALE_MS = 5 * 60_000;
/**
 * A `pending` row (created, generation not yet claimed) cannot heartbeat — its
 * `updatedAt` is the claim's compare-and-set fence. Claiming takes seconds, so
 * a much longer threshold is still unambiguous.
 */
export const PENDING_STALE_MS = 15 * 60_000;
/** How often the sweep runs after the startup pass. */
export const INTERRUPTED_SWEEP_INTERVAL_MS = 60_000;

/** Stored on the row and shown in the UI; user-safe, no internal detail. */
export const GENERATION_INTERRUPTED_MESSAGE =
  "Generation was interrupted before it finished: the server restarted or stopped while it was running. Regenerate the document to try again.";

/**
 * Keep a claimed generation's row fresh until the returned stop function is
 * called. Writes only while this run still holds `claim`, so a run that has
 * been superseded or failed can never revive the row.
 */
export function startGenerationHeartbeat(
  docId: string,
  projectId: string,
  claim: string,
  intervalMs: number = GENERATION_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    prisma.generatedDocument
      .updateMany({
        where: {
          id: docId,
          projectId,
          deletedAt: null,
          status: "generating",
          codeGraphHash: claim,
        },
        data: { updatedAt: new Date() },
      })
      .catch((err: unknown) =>
        log.warn("Generation heartbeat failed", { docId, err: String(err) }),
      );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Fail every document whose generation has no live process. Each row is
 * updated compare-and-set on the status and `updatedAt` it was read with, so a
 * row that heartbeats (or is claimed) between the read and the write is left
 * alone. Returns how many rows were failed.
 */
export async function failInterruptedGenerations(now: Date = new Date()): Promise<number> {
  const stale = await prisma.generatedDocument.findMany({
    where: {
      deletedAt: null,
      OR: [
        { status: "generating", updatedAt: { lt: new Date(now.getTime() - GENERATING_STALE_MS) } },
        { status: "pending", updatedAt: { lt: new Date(now.getTime() - PENDING_STALE_MS) } },
      ],
    },
    select: { id: true, projectId: true, status: true, updatedAt: true },
  });
  let failed = 0;
  for (const doc of stale) {
    const result = await prisma.generatedDocument.updateMany({
      where: {
        id: doc.id,
        projectId: doc.projectId,
        deletedAt: null,
        status: doc.status,
        updatedAt: doc.updatedAt,
      },
      data: {
        status: "failed",
        errorMessage: GENERATION_INTERRUPTED_MESSAGE,
        // A `generating` row holds the dead run's claim here; clearing it means
        // that run can never commit or fail over this row if it was only stalled.
        ...(doc.status === "generating" ? { codeGraphHash: null } : {}),
      },
    });
    if (!result.count) continue;
    failed += 1;
    jobEvents.failed("doc-generation", doc.id, doc.projectId, GENERATION_INTERRUPTED_MESSAGE);
  }
  if (failed > 0) log.warn("Failed interrupted documentation generations", { count: failed });
  return failed;
}

/**
 * Run {@link failInterruptedGenerations} now and then every
 * {@link INTERRUPTED_SWEEP_INTERVAL_MS}. Independent of the scheduler, which
 * can be disabled. Returns a stop function.
 */
export function startInterruptedGenerationSweeper(
  intervalMs: number = INTERRUPTED_SWEEP_INTERVAL_MS,
): () => void {
  const sweep = (): void => {
    failInterruptedGenerations().catch((err: unknown) =>
      log.warn("Interrupted-generation sweep failed", { err: String(err) }),
    );
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
