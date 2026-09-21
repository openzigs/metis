/** Successful-ingest → durable, revision-fenced production regeneration (#1356). */
import { prisma } from "../prisma.js";
import { z } from "zod";
import { AppError } from "../../middleware/error-handler.js";
import { createChildLogger } from "../logger.js";
import { getSchedulerBootstrap } from "../scheduler/index.js";
import { resolveEvidencePolicy } from "./evidence-policy.js";
import { captureGenerationInputs } from "./generation-inputs.js";
import { parseGeneratedDocVersionManifest } from "./generated-doc-provenance.js";
import { inputHash, planRegeneration, type RegenerationTask } from "./regeneration-plan.js";
export { regenerationTaskSchema, type RegenerationTask } from "./regeneration-plan.js";

export const REGENERATE_DOCUMENT_TASK = "regenerate-generated-document";
const log = createChildLogger("docs-gen-incremental");
const scopeFilterSchema = z.record(z.unknown());
const repositoryFilterSchema = z.object({ repoConnectorId: z.string().trim().min(1) });

/** Only after graph, source knowledge and metadata settle. Enqueue errors
 * propagate: replaying successful ingestion retries scheduling as well. */
export async function checkIncrementalRegeneration(
  projectId: string,
  repoConnectorId?: string,
): Promise<void> {
  const docs = await prisma.generatedDocument.findMany({
    where: {
      projectId,
      autoUpdate: true,
      deletedAt: null,
      status: { in: ["ready", "degraded", "failed", "generating"] },
      scope: { in: ["full", "repository", "module", "symbol"] },
    },
    select: {
      id: true,
      projectId: true,
      title: true,
      scope: true,
      scopeFilter: true,
      evidencePolicy: true,
    },
  });
  let failure: { error: unknown } | undefined;
  for (const doc of docs) {
    try {
      // Classify only persisted-input parsing and known authorization denials as
      // permanent. Capture, database and queue errors must remain retryable.
      try {
        const filter = scopeFilterSchema.parse(JSON.parse(doc.scopeFilter));
        if (doc.scope === "repository") {
          const repository = repositoryFilterSchema.parse(filter);
          if (repoConnectorId && repository.repoConnectorId !== repoConnectorId) continue;
        }
      } catch (err) {
        if (!(err instanceof SyntaxError || err instanceof z.ZodError)) throw err;
        log.warn("Skipping automatic regeneration: invalid stored scope");
        continue;
      }
      let policy;
      try {
        policy = await resolveEvidencePolicy(doc);
      } catch (err) {
        if (
          !(
            err instanceof AppError &&
            ((err.statusCode === 403 && err.code === "GENERATION_AUTH_UNAVAILABLE") ||
              (err.statusCode === 404 &&
                ["NOT_FOUND", "REPOSITORY_GRAPH_UNAVAILABLE"].includes(err.code)))
          )
        )
          throw err;
        log.warn("Skipping automatic regeneration: authorization unavailable");
        continue;
      }
      const snapshot = await captureGenerationInputs(doc, policy);
      const latest = await prisma.generatedDocumentVersion.findFirst({
        where: { documentId: doc.id },
        orderBy: { version: "desc" },
        select: {
          version: true,
          provenanceManifest: true,
        },
      });
      let previous;
      try {
        previous = latest?.provenanceManifest
          ? (parseGeneratedDocVersionManifest(latest.provenanceManifest).inputSnapshot ?? null)
          : null;
      } catch (err) {
        if (!(err instanceof SyntaxError || err instanceof z.ZodError)) throw err;
        log.warn("Skipping automatic regeneration: invalid stored manifest");
        continue;
      }
      if (planRegeneration(previous, snapshot).mode === "unchanged") continue;
      const payload: RegenerationTask = {
        projectId,
        generatedDocumentId: doc.id,
        expectedVersion: latest?.version ?? 0,
        fingerprint: snapshot.fingerprint,
      };
      const id = `docs-regen:${inputHash(payload)}`;
      const task = await prisma.task.upsert({
        where: { id },
        update: {},
        create: {
          id,
          projectId,
          type: REGENERATE_DOCUMENT_TASK,
          payload: JSON.stringify(payload),
          maxAttempts: 3,
          createdById: policy.actor.userId,
        },
      });
      // A new successful ingest may retry an exhausted attempt at the same inputs.
      // Compare-and-set preserves manual cancellation and concurrently claimed work.
      if (task.status === "failed") {
        await prisma.task.updateMany({
          where: { id: task.id, status: "failed" },
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
      const { readTaskRecord } = await import("../scheduler/task-store.js");
      const record = await readTaskRecord(task.id);
      if (record?.status === "pending") getSchedulerBootstrap().queue.resume(record);
    } catch (error) {
      // Retain one failure (bounded memory), but attempt every eligible document.
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

export async function runRegenerationTask(
  payload: RegenerationTask,
  signal: AbortSignal,
): Promise<void> {
  const { generateDocumentAsync } = await import("../../routes/generated-docs.js");
  await generateDocumentAsync(payload.generatedDocumentId, payload.projectId, {
    ...payload,
    signal,
  });
}
