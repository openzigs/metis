/** Successful-ingest → durable, revision-fenced production regeneration (#1356). */
import { prisma } from "../prisma.js";
import { z } from "zod";
import { AppError } from "../../middleware/error-handler.js";
import { createChildLogger } from "../logger.js";
import { getSchedulerBootstrap } from "../scheduler/index.js";
import { resolveEvidencePolicy } from "./evidence-policy.js";
import { captureGenerationInputs } from "./generation-inputs.js";
import { readsApprovedRequirements } from "./approved-requirements-section.js";
import {
  approvedRequirementsScopeOf,
  isScopedApprovedRequirements,
} from "./approved-requirements-scope.js";
import { InvalidStoredPathScopeError, readStoredPathScope } from "./path-scope.js";
import { parseGeneratedDocVersionManifest } from "./generated-doc-provenance.js";
import { settleExtractorUpgrade } from "./extractor-upgrade.js";
import { inputHash, type RegenerationTask } from "./regeneration-plan.js";
export { regenerationTaskSchema, type RegenerationTask } from "./regeneration-plan.js";

export const REGENERATE_DOCUMENT_TASK = "regenerate-generated-document";
const log = createChildLogger("docs-gen-incremental");
const scopeFilterSchema = z.record(z.string(), z.unknown());
const repositoryFilterSchema = z.object({ repoConnectorId: z.string().trim().min(1) });

/** Only after graph, source knowledge and metadata settle. Enqueue errors
 * propagate: replaying successful ingestion retries scheduling as well.
 * #1230 — `approvedRequirementsOnly` checks only the documents whose inputs
 * include the project's approved requirements (`readsApprovedRequirements`):
 * after a requirement write, no other document's inputs can have changed.
 * #1246 — `scopedApprovedRequirementsOnly` narrows that to the repository- or
 * path-scoped ones: a code-link write changes only a scoped document's list
 * (an unscoped one hashes no code link), so the others skip the capture. */
export async function checkIncrementalRegeneration(
  projectId: string,
  repoConnectorId?: string,
  options: { approvedRequirementsOnly?: boolean; scopedApprovedRequirementsOnly?: boolean } = {},
): Promise<void> {
  const rows = await prisma.generatedDocument.findMany({
    where: {
      projectId,
      autoUpdate: true,
      deletedAt: null,
      OR: [
        { status: { in: ["ready", "degraded", "failed", "generating"] } },
        // #855 / #867 — a cancelled (or cancelling) document keeps tracking
        // ingests only once it has a published version. One that never
        // published would restart as a full run: a cancel must stop the spend.
        { status: { in: ["cancelled", "cancelling"] }, versions: { some: {} } },
      ],
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
  const docs = options.scopedApprovedRequirementsOnly
    ? rows.filter((doc) => readsApprovedRequirements(doc) && hasScopedApprovedRequirements(doc))
    : options.approvedRequirementsOnly
      ? rows.filter(readsApprovedRequirements)
      : rows;
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
        // #1246 — the capture below reads the stored path scope too (a
        // reader BRD's approved requirements); a corrupt one is permanent.
        readStoredPathScope(filter);
      } catch (err) {
        if (!(
          err instanceof SyntaxError ||
          err instanceof z.ZodError ||
          err instanceof InvalidStoredPathScopeError
        ))
          throw err;
        log.warn("Skipping automatic regeneration: invalid stored scope");
        continue;
      }
      let policy;
      try {
        policy = await resolveEvidencePolicy(doc);
      } catch (err) {
        if (!(
          err instanceof AppError &&
          ((err.statusCode === 403 && err.code === "GENERATION_AUTH_UNAVAILABLE") ||
            (err.statusCode === 404 &&
              ["NOT_FOUND", "REPOSITORY_GRAPH_UNAVAILABLE"].includes(err.code)))
        ))
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
      // #1071 — unchanged against what the latest version stands for; or
      // changed only because an extractor upgrade rewrote the graph, seen here
      // for the first time. That is acknowledged — once — and spends nothing.
      const settled = await settleExtractorUpgrade({
        documentId: doc.id,
        latest,
        published: previous,
        current: snapshot,
      });
      if (settled.outcome === "unchanged") continue;
      if (settled.outcome === "acknowledged") {
        log.info(
          "Skipping automatic regeneration: a code-graph extractor upgrade rewrote the graph and nothing else changed; acknowledged",
          { projectId, generatedDocumentId: doc.id, version: latest?.version },
        );
        continue;
      }
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

/**
 * #1246 — whether a document's approved requirements are limited to a
 * repository or paths. A corrupt stored scope counts as scoped, so the check
 * reaches it and skips it as permanently invalid, with its log line.
 */
function hasScopedApprovedRequirements(doc: { scope: string; scopeFilter: string }): boolean {
  try {
    return isScopedApprovedRequirements(approvedRequirementsScopeOf(doc));
  } catch {
    return true;
  }
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
