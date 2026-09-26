/**
 * Issue #189 — startup repair of generated-document publications that were left
 * without an outcome.
 *
 * The durable outbox (`generated-doc-outbox.ts` + the scheduler's
 * `recoverDurableTasks`) already replays a publication TASK that was pending or
 * running when the process died. What nothing repaired was the synthetic
 * `documents` row the task writes, in three shapes found on a real dev database:
 *
 *  - chunks embedded and parked for review, task `completed`, row still
 *    `processing` — the pre-#189 not-auto-approved path never wrote an outcome;
 *  - task exhausted its attempts (`failed`), row still `processing`;
 *  - no task left to finish the row at all.
 *
 * Each synthetic row that is `pending`/`processing` and NOT owned by a live task is
 * settled exactly once here: finalized as awaiting review, marked failed with the
 * task's error (or, #201, as cancelled when a user cancelled its task), removed if
 * its revision is no longer publishable, or re-armed so the normal task path
 * finishes it. A live (pending/running) task always wins — this
 * never runs a publication itself.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import {
  dispatchGeneratedDocTask,
  generatedDocOutboxId,
  persistGeneratedDocTask,
} from "./generated-doc-outbox.js";
import {
  GENERATED_DOC_PUBLICATION_CANCELLED,
  markAwaitingReview,
  readPublicationSnapshot,
  reconcileSyntheticDocumentRemoval,
  type GeneratedDocPublicationTaskPayload,
} from "./generated-doc-publication.js";

const log = createChildLogger("docs-gen:publication-recovery");
const PREFIX = "gendoc-";

export interface StrandedPublicationReport {
  /** Chunks were parked for review — now `ready` (pending review). */
  finalized: string[];
  /** Task exhausted its attempts — now `failed`, with the task's error. */
  failed: string[];
  /** #201 — task cancelled by a user — now `failed`, "cancelled"; never re-run. */
  cancelled: string[];
  /** Revision deleted/superseded/missing — synthetic document removed. */
  removed: string[];
  /** No live task and no outcome — publication task re-armed and dispatched. */
  rearmed: string[];
  /** Owned by a live task, or a legacy unversioned id. */
  skipped: string[];
}

/** `gendoc-<generatedDocumentId>:<revisionId>` → parts; null for a legacy id. */
export function parseSyntheticDocumentId(
  id: string,
): { generatedDocumentId: string; revisionId: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const separator = id.indexOf(":", PREFIX.length);
  if (separator <= PREFIX.length) return null;
  const revisionId = id.slice(separator + 1);
  if (!revisionId) return null;
  return { generatedDocumentId: id.slice(PREFIX.length, separator), revisionId };
}

export interface StrandedPublicationDeps {
  dispatchTask?: (taskId: string) => Promise<void>;
}

export async function reconcileStrandedGeneratedDocPublications(
  deps: StrandedPublicationDeps = {},
): Promise<StrandedPublicationReport> {
  const dispatch = deps.dispatchTask ?? dispatchGeneratedDocTask;
  const report: StrandedPublicationReport = {
    finalized: [],
    failed: [],
    cancelled: [],
    removed: [],
    rearmed: [],
    skipped: [],
  };
  const rows = await prisma.document.findMany({
    where: {
      id: { startsWith: PREFIX },
      deletedAt: null,
      status: { in: ["pending", "processing"] },
      indexState: { in: ["pending", "quarantined"] },
    },
    select: { id: true, projectId: true, indexState: true },
  });

  for (const row of rows) {
    try {
      await reconcileOne(row, report, dispatch);
    } catch (err) {
      // One bad row must not stop the rest; it is retried on the next start.
      log.warn("Could not reconcile stranded generated-doc publication", {
        documentId: row.id,
        error: (err as Error).message,
      });
      report.skipped.push(row.id);
    }
  }
  const settled =
    report.finalized.length +
    report.failed.length +
    report.cancelled.length +
    report.removed.length +
    report.rearmed.length;
  if (settled > 0) log.info("Reconciled stranded generated-doc publications", { ...report });
  return report;
}

async function reconcileOne(
  row: { id: string; projectId: string; indexState: string },
  report: StrandedPublicationReport,
  dispatch: (taskId: string) => Promise<void>,
): Promise<void> {
  const parsed = parseSyntheticDocumentId(row.id);
  if (!parsed) {
    // Legacy unversioned identities are read/cleanup-only; a later revision's
    // publication removes them (`removeOlderPublications`).
    report.skipped.push(row.id);
    return;
  }
  const version = await prisma.generatedDocumentVersion.findFirst({
    where: { documentId: parsed.generatedDocumentId, revisionId: parsed.revisionId },
    select: { version: true },
  });
  const versionNumber = version?.version ?? Number(/:v(\d+)$/.exec(parsed.revisionId)?.[1]);
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    await reconcileSyntheticDocumentRemoval(row.id, row.projectId);
    report.removed.push(row.id);
    return;
  }
  const payload: GeneratedDocPublicationTaskPayload = {
    projectId: row.projectId,
    generatedDocumentId: parsed.generatedDocumentId,
    version: versionNumber,
    revisionId: parsed.revisionId,
  };
  const taskId = generatedDocOutboxId(payload);
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, errorMessage: true },
  });
  if (task && (task.status === "pending" || task.status === "running")) {
    report.skipped.push(row.id);
    return;
  }

  const snapshot = await readPublicationSnapshot(payload);
  if (snapshot.status !== "publishable") {
    await reconcileSyntheticDocumentRemoval(row.id, row.projectId);
    report.removed.push(row.id);
    return;
  }

  const parked = await prisma.quarantineChunk.count({
    where: { documentId: row.id, ord: { gte: 0 } },
  });
  if (row.indexState === "quarantined" && parked > 0) {
    await markAwaitingReview(row.id, row.projectId);
    report.finalized.push(row.id);
    return;
  }
  if (task?.status === "failed") {
    await prisma.document.updateMany({
      where: { id: row.id, projectId: row.projectId, deletedAt: null },
      data: {
        status: "failed",
        errorMessage: `generated-doc publication failed: ${task.errorMessage ?? "unknown error"}`,
        processedAt: new Date(),
      },
    });
    report.failed.push(row.id);
    return;
  }
  if (task?.status === "cancelled") {
    // #201 — a user's cancellation is never overridden (the task is not re-run),
    // but the row is settled: a cancelled publication is not `processing`.
    await prisma.document.updateMany({
      where: { id: row.id, projectId: row.projectId, deletedAt: null },
      data: {
        status: "failed",
        errorMessage: `${GENERATED_DOC_PUBLICATION_CANCELLED}: ${task.errorMessage ?? "cancelled"}`,
        processedAt: new Date(),
      },
    });
    report.cancelled.push(row.id);
    return;
  }

  // No task, or a task that completed without leaving an outcome: run it again
  // through the normal durable path.
  const createdById = await prisma.document
    .findUnique({ where: { id: row.id }, select: { uploadedById: true } })
    .then((doc) => doc?.uploadedById ?? null);
  await prisma.$transaction(async (tx) => {
    await persistGeneratedDocTask(tx, payload, createdById);
    await tx.task.updateMany({
      where: { id: taskId, status: "completed" },
      data: {
        status: "pending",
        attempts: 0,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        progress: null,
        result: null,
      },
    });
  });
  await dispatch(taskId);
  report.rearmed.push(row.id);
}
