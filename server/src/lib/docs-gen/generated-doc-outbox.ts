import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { createChildLogger } from "../logger.js";
import { getSchedulerBootstrap } from "../scheduler/index.js";
import { readTaskRecord } from "../scheduler/task-store.js";
import {
  GENERATED_DOC_PUBLICATION_TASK_TYPE,
  type GeneratedDocPublicationTaskPayload,
} from "./generated-doc-publication.js";

const log = createChildLogger("docs-gen:outbox");
type Operation = "publish" | "delete";

export function generatedDocOutboxId(
  payload: GeneratedDocPublicationTaskPayload,
  operation: Operation = "publish",
): string {
  // Tuple encoding avoids delimiter collisions; deletion has its own intent even
  // if the publication was already completed or deliberately cancelled.
  const identity = JSON.stringify([
    payload.projectId,
    payload.generatedDocumentId,
    payload.version,
    payload.revisionId,
  ]);
  return `docs-${operation}:${createHash("sha256").update(identity).digest("hex")}`;
}

/** Call ONLY inside the transaction that commits the version or tombstone.
 * Publication replay never resets terminal work. An explicit DELETE can retry
 * exhausted cleanup, but must preserve user cancellation and completed work. */
export async function persistGeneratedDocTask(
  tx: Prisma.TransactionClient,
  payload: GeneratedDocPublicationTaskPayload,
  createdById: string | null,
  operation: Operation = "publish",
): Promise<string> {
  const id = generatedDocOutboxId(payload, operation);
  const task = await tx.task.upsert({
    where: { id },
    update: {},
    create: {
      id,
      type: GENERATED_DOC_PUBLICATION_TASK_TYPE,
      projectId: payload.projectId,
      payload: JSON.stringify(payload),
      createdById,
      maxAttempts: 3,
    },
  });
  if (operation === "delete" && task.status === "failed") {
    await tx.task.updateMany({
      where: { id, status: "failed" },
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
  }
  return id;
}

/** Best-effort wake-up AFTER commit. The scheduler's startup/periodic recovery
 * owns pending rows if the process dies, the queue stops, or this wake-up fails. */
export async function dispatchGeneratedDocTask(id: string): Promise<void> {
  try {
    const record = await readTaskRecord(id);
    if (record?.status === "pending") getSchedulerBootstrap().queue.resume(record);
  } catch (err) {
    log.warn("Generated-doc task persisted; dispatch deferred to recovery", { id, err });
  }
}
