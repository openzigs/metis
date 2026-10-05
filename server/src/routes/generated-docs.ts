/**
 * `/api/projects/:projectId/docs` — Auto Documentation Generator REST surface
 * (Epic #486 / Issue #487).
 *
 * Routes:
 *   POST   /generate             — trigger doc generation for a project
 *   GET    /                     — list generated documents
 *   GET    /:docId               — get a single document (content + summary metadata)
 *   GET    /:docId/versions/:versionId                 — one version's markdown (#190)
 *   GET    /:docId/versions/:versionId/provenance      — its provenance manifest (#190)
 *   GET    /:docId/versions/:versionId/provenance/summary — the panel's summary of it (#196)
 *   GET    /:docId/versions/:versionId/changed-symbols — its changed symbols, paged (#190)
 *   GET    /:docId/export        — export as PDF or Word
 *   GET    /:docId/schema-graph  — structured schema graph (Epic #895)
 *   PATCH  /:docId               — update metadata (title, autoUpdate)
 *   DELETE /:docId               — soft-delete a document
 *   POST   /:docId/cancel        — cancel a pending or running generation (#855)
 */
import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { RequestHandler } from "express";
import * as authMiddleware from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import {
  generatedDocsPreAuthRateLimiter,
  generatedDocsRateLimiter,
} from "../middleware/generated-docs-rate-limit.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma, Prisma } from "../lib/prisma.js";
import { assertDocumentExportable } from "../lib/reviews/approval-gate.js";
import { createChildLogger } from "../lib/logger.js";
import { jobEvents, genericFailureMessage } from "../lib/socket/job-events.js";
import type { SchemaGraph } from "@metis/shared";
import {
  createEvidencePolicy,
  resolveEvidencePolicy,
  requireRepositoryGraph,
} from "../lib/docs-gen/evidence-policy.js";
import {
  buildGeneratedDocVersionManifest,
  databaseSourceFingerprintOf,
  graphFingerprintOf,
  graphFingerprintOfValue,
  generatedDocRevisionId,
} from "../lib/docs-gen/generated-doc-provenance.js";
import {
  cachedChangedSymbols,
  cachedProvenanceSummary,
  type GeneratedDocProvenanceSummary,
  type GeneratedDocVersionRowKey,
} from "../lib/docs-gen/generated-doc-version-reads.js";
import {
  PHASE1_PROMPT_VERSION,
  buildDocsGenProvider,
  resolvePhase2Router,
} from "../lib/docs-gen/holistic-synthesizer.js";
import { generatedDocSyntheticDocumentId } from "../lib/docs-gen/generated-doc-publication.js";
import {
  documentProgressPercent,
  monotonicPercent,
  phase1ProgressMessage,
  phase1ProgressPercent,
  sectionProgressMessage,
} from "../lib/docs-gen/section-progress.js";
import {
  generatedDocOutboxId,
  persistGeneratedDocTask,
  dispatchGeneratedDocTask,
} from "../lib/docs-gen/generated-doc-outbox.js";
import { captureGenerationInputs } from "../lib/docs-gen/generation-inputs.js";
import { TaskAbortError } from "../lib/scheduler/task-abort.js";
import type { DocWarning as DocWarningShape } from "../lib/docs-gen/grounding/degraded-warnings.js";
import {
  generationFailureWarning,
  partialDocumentMarkdown,
  UnpublishableGenerationError,
  type GenerationStage,
} from "../lib/docs-gen/generation-checkpoint.js";
import {
  buildGenerationCheckpoint,
  type SectionSynthesisRecord,
} from "../lib/docs-gen/section-reuse.js";
import {
  PATH_SCOPE_EMPTY_CODE,
  pathPrefixesSchema,
  pathScopeLabel,
  pathScopeWhere,
  probePathScope,
  readStoredPathScope,
  scopedDocumentTitle,
} from "../lib/docs-gen/path-scope.js";
import {
  legacyGeneratedDocVersionManifest,
  parseGeneratedDocVersionManifest,
} from "../lib/docs-gen/generated-doc-provenance.js";
import {
  planRegeneration,
  type GenerationInputSnapshot,
} from "../lib/docs-gen/regeneration-plan.js";
import type { RegenerationTask } from "../lib/docs-gen/incremental.js";
import {
  GENERATION_CANCELLED_MESSAGE,
  GENERATION_INTERRUPTED_MESSAGE,
  startGenerationHeartbeat,
} from "../lib/docs-gen/interrupted-generations.js";
import {
  generationFailureMessage,
  publicDocWarnings,
  publicGenerationErrorMessage,
} from "../lib/docs-gen/generation-failure-message.js";
import {
  releaseGenerationControl,
  startGenerationControl,
  stopGeneration,
  type GenerationControl,
} from "../lib/docs-gen/generation-control.js";
import { withGenerationScope } from "../lib/docs-gen/generation-scope.js";
import type {
  GenerationStepHook,
  SectionResumeReport,
} from "../lib/docs-gen/holistic-synthesizer.js";
import {
  INDEXING_PUBLICATION_CANCELLED_MESSAGE,
  isGeneratedDocPublicationCancelled,
  publicIndexingErrorMessage,
} from "../lib/rag/indexing-failure-message.js";

const log = createChildLogger("generated-docs");

type IndexingVersion = { version: number; revisionId: string | null };
type PublicationState = { status: string; errorMessage: string | null };

function publicationId(projectId: string, docId: string, version?: IndexingVersion) {
  return version?.revisionId
    ? generatedDocOutboxId({
        projectId,
        generatedDocumentId: docId,
        version: version.version,
        revisionId: version.revisionId,
      })
    : null;
}

/**
 * Pre-publication versions can have a backfilled revision ID. A real current
 * manifest (or an unreadable one) is not evidence of a legacy publication; a
 * version with no stored manifest is. #196 — the manifest is consulted only
 * when there is no outbox, and through the per-version summary cache.
 */
async function canUseLegacyIndex(
  version: GeneratedDocVersionRowKey | undefined,
  outbox?: PublicationState,
): Promise<boolean> {
  if (outbox) return false;
  if (!version) return true;
  const summary = await versionSummary(version);
  return summary?.legacy.historicalCitations === "legacy-unknown";
}

type SyntheticIndexRow = {
  indexState: string;
  status: string;
  chunkCount: number;
  errorMessage: string | null;
  processedAt: Date | null;
};

/** #489 — what `indexing` reports for a publication a user cancelled. */
const CANCELLED_INDEX = {
  state: "cancelled",
  status: "cancelled",
  errorMessage: INDEXING_PUBLICATION_CANCELLED_MESSAGE,
} as const;

function syntheticIndex(document: SyntheticIndexRow) {
  const index = {
    state: document.indexState,
    status: document.status,
    chunkCount: document.chunkCount,
    // #98 — never the ingest pipeline's raw exception text.
    errorMessage: publicIndexingErrorMessage(document.errorMessage, document.indexState),
    processedAt: document.processedAt,
  };
  // #489 — a cancelled row keeps its `pending`/`quarantined` indexState, so the
  // badge said "pending" beside a "cancelled" message. The row carries the
  // prefixed text #201 writes; the classifier reads the same predicate. Only
  // those two states can be a cancelled publication: the recovery write has no
  // indexState filter, so a stale prefix must not relabel an indexed row.
  const cancellable = document.indexState === "pending" || document.indexState === "quarantined";
  return cancellable && isGeneratedDocPublicationCancelled(document.errorMessage)
    ? { ...index, ...CANCELLED_INDEX }
    : index;
}

function unpublishedIndex(outbox?: PublicationState | null) {
  // #232 / #489 — detected on the task's status, not through the classifier's
  // `isGeneratedDocPublicationCancelled`: the outbox task stores the bare
  // cancellation reason with no `generated-doc publication cancelled` prefix
  // (only the synthetic row's text carries it). Keep the two in step.
  if (outbox?.status === "cancelled") {
    return { ...CANCELLED_INDEX, chunkCount: 0, processedAt: null };
  }
  const failed = outbox?.status === "failed";
  return {
    state: failed ? "failed" : "pending",
    status: failed ? "failed" : outbox?.status === "running" ? "processing" : "pending",
    chunkCount: 0,
    // #98 — the outbox task's error is the publication's own exception text.
    errorMessage: failed ? publicIndexingErrorMessage(outbox.errorMessage) : null,
    processedAt: null,
  };
}

/**
 * Rate limiter for the expensive /generate endpoint (LLM calls).
 * 5 requests per 15 minutes per authenticated user.
 */
// `as unknown as RequestHandler` bridges the Express 4↔5 type split.
const generateRateLimiter: RequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    req.user?.userId ??
    ipKeyGenerator(req.ip ?? "", res.req?.socket?.remoteFamily === "IPv6" ? 64 : 32) ??
    "anonymous",
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT",
      message: "Documentation generation rate limit exceeded (5/15min). Try again later.",
    },
  },
}) as unknown as RequestHandler;

const generateSchema = z
  .object({
    title: z.string().min(1).max(200),
    scope: z.enum(["full", "module", "symbol", "repository", "database"]).default("full"),
    /** Holistic document type. Only used when scope === "full" or "repository". */
    docType: z
      .enum(["business-requirements", "architecture", "user-guide"])
      .optional()
      .default("business-requirements"),
    scopeFilter: z.record(z.string(), z.unknown()).optional().default({}),
    autoUpdate: z.boolean().optional().default(false),
    sharedReferenceDocumentIds: z.array(z.string().min(1)).max(100).default([]),
    /**
     * #283 — opt-in: ground the doc's narrative domain sections with web
     * research. Default OFF so there are no surprise network calls / cost. When
     * true, doc-gen runs the existing WebResearchAugmenter for the project's
     * domain/overview topic and persists the digests into the grounding store
     * BEFORE synthesis, so the per-section grounding set includes them.
     */
    groundDomainWithWebResearch: z.boolean().optional().default(false),
    /**
     * Path scope: repository-relative prefixes (e.g. `["packages/fit/"]`). Only
     * code under them is documented. `full` / `repository` scopes only.
     */
    pathPrefixes: pathPrefixesSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.pathPrefixes && data.scope !== "full" && data.scope !== "repository") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pathPrefixes is only supported when scope is 'full' or 'repository'",
        path: ["pathPrefixes"],
      });
    }
    if (Object.prototype.hasOwnProperty.call(data.scopeFilter, "pathPrefixes")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pass pathPrefixes at the top level of the request, not inside scopeFilter",
        path: ["scopeFilter", "pathPrefixes"],
      });
    }
    if (
      data.scope === "repository" &&
      typeof (data.scopeFilter as Record<string, unknown>).repoConnectorId !== "string"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scopeFilter.repoConnectorId is required when scope is 'repository'",
        path: ["scopeFilter", "repoConnectorId"],
      });
    }
    if (
      data.scope === "database" &&
      typeof (data.scopeFilter as Record<string, unknown>).dbConnectorId !== "string"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scopeFilter.dbConnectorId is required when scope is 'database'",
        path: ["scopeFilter", "dbConnectorId"],
      });
    }
  });

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  autoUpdate: z.boolean().optional(),
});

/** #190 — a version's stored manifest, read only when a caller needs it. */
async function storedManifest(documentId: string, versionId: string): Promise<string | null> {
  const stored = await prisma.generatedDocumentVersion.findFirst({
    where: { id: versionId, documentId },
    select: { provenanceManifest: true },
  });
  return stored?.provenanceManifest ?? null;
}

/**
 * #196 — a version's provenance summary, reading and parsing its (possibly
 * multi-megabyte) manifest at most once per process. `null` = unreadable.
 */
function versionSummary(
  row: GeneratedDocVersionRowKey,
): Promise<GeneratedDocProvenanceSummary | null> {
  return cachedProvenanceSummary(row, () => storedManifest(row.documentId, row.versionId));
}

function rowKey(
  projectId: string,
  documentId: string,
  version: { id: string; version: number; createdAt: Date },
): GeneratedDocVersionRowKey {
  return {
    projectId,
    documentId,
    versionId: version.id,
    version: version.version,
    createdAt: version.createdAt,
  };
}

/**
 * #190 — the revision id the detail payload has always reported, without
 * loading the (potentially multi-megabyte) manifest for rows that store it.
 */
async function versionRevisionId(
  projectId: string,
  generatedDocumentId: string,
  version: { id: string; version: number; revisionId: string | null; createdAt: Date },
): Promise<string> {
  if (version.revisionId) return version.revisionId;
  const summary = await versionSummary(rowKey(projectId, generatedDocumentId, version));
  if (!summary) {
    throw new AppError(500, "PROVENANCE_CORRUPT", "Stored provenance manifest is not readable");
  }
  return summary.revisionId;
}

const refreshAuthenticatedUser: RequestHandler =
  authMiddleware.refreshAuthenticatedUser ?? ((_req, _res, next) => next());

export function generatedDocsRouter(): Router {
  const r = Router({ mergeParams: true });
  // #632 (CodeQL js/missing-rate-limiting #202) — a per-IP ceiling ahead of JWT
  // verification, then a per-user budget ahead of the DB-reading refresh.
  r.use(generatedDocsPreAuthRateLimiter);
  r.use(authMiddleware.requireAuth);
  r.use(generatedDocsRateLimiter);
  r.use(refreshAuthenticatedUser);
  // Epic #671 / #674 — object-level project scope (OWASP A01 / BOLA). Generate,
  // list, get, export and delete are all addressed under
  // `/projects/:projectId/docs`; a foreign `docId` under a foreign `projectId`
  // must not disclose or mutate another tenant's generated docs. Gate on the
  // caller's workspace membership before any handler runs (non-members → 404).
  r.use(requireProjectAccess());

  const getProjectId = (req: Request): string => {
    const id = req.params.projectId;
    if (Array.isArray(id)) return id[0];
    return id;
  };

  const getDocId = (req: Request): string => {
    const id = req.params.docId;
    if (Array.isArray(id)) return id[0];
    return id;
  };

  // POST /generate — trigger generation (rate-limited: 5/15min per user)
  r.post(
    "/generate",
    generateRateLimiter,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const projectId = getProjectId(req);
      const parsed = generateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", parsed.error.message);
      }

      const project = await prisma.project.findFirst({
        where: { id: projectId, deletedAt: null },
      });
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");

      let scopedCodeGraphId: string | undefined;
      if (parsed.data.scope === "repository") {
        scopedCodeGraphId = await requireRepositoryGraph(
          projectId,
          parsed.data.scopeFilter.repoConnectorId as string,
        );
      }
      const pathPrefixes = parsed.data.pathPrefixes;
      if (pathPrefixes) {
        // Fail fast with a clear 400 instead of a long run that ends empty.
        // The DB filter over-matches (unescaped LIKE), so each candidate is
        // confirmed exactly; see probePathScope.
        const probe = await probePathScope(pathPrefixes, ({ afterId, take }) =>
          prisma.codeSymbol.findMany({
            where: {
              projectId,
              ...(scopedCodeGraphId ? { codeGraphId: scopedCodeGraphId } : {}),
              ...(afterId ? { id: { gt: afterId } } : {}),
              OR: pathScopeWhere(pathPrefixes),
            },
            select: { id: true, filePath: true },
            orderBy: { id: "asc" },
            take,
          }),
        );
        if (probe === "none") {
          throw new AppError(
            400,
            PATH_SCOPE_EMPTY_CODE,
            `No indexed code matches pathPrefixes (${pathScopeLabel(pathPrefixes)}). Prefixes are repository-relative, e.g. packages/fit/.`,
          );
        }
      }
      // req.user is authenticated by the existing route gate, NOT scope metadata.
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const evidencePolicy = createEvidencePolicy(req.user, {
        sharedDocumentIds: parsed.data.sharedReferenceDocumentIds,
        allowWebResearch: parsed.data.groundDomainWithWebResearch,
      });

      const doc = await prisma.generatedDocument.create({
        data: {
          projectId,
          evidencePolicy,
          // A scoped document says so in its title, so it is never mistaken for a full one.
          title: pathPrefixes
            ? scopedDocumentTitle(parsed.data.title, pathPrefixes)
            : parsed.data.title,
          scope: parsed.data.scope,
          // Stash docType + actorId inside scopeFilter so we don't need a schema migration.
          scopeFilter: JSON.stringify({
            ...parsed.data.scopeFilter,
            docType: parsed.data.docType,
            actorId: req.user?.userId ?? "system",
            // #283 — stash the opt-in domain web-research flag (no schema migration).
            groundDomainWithWebResearch: parsed.data.groundDomainWithWebResearch,
            ...(pathPrefixes ? { pathPrefixes } : {}),
          }),
          autoUpdate: parsed.data.autoUpdate,
          status: "pending",
        },
      });

      // Kick off async generation (fire-and-forget)
      void generateDocumentAsync(doc.id, projectId).catch((err) => {
        log.error("Background doc generation failed", { err, docId: doc.id });
      });

      res.status(202).json({ data: doc });
    },
  );

  // GET / — list documents
  r.get("/", requirePermission("project.read"), async (req: Request, res: Response) => {
    const projectId = getProjectId(req);
    const docs = await prisma.generatedDocument.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        scope: true,
        status: true,
        autoUpdate: true,
        generatedAt: true,
        createdAt: true,
        updatedAt: true,
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { id: true, version: true, revisionId: true, createdAt: true },
        },
      },
    });
    const outboxIds = docs.flatMap((doc) => {
      const id = publicationId(projectId, doc.id, doc.versions?.[0]);
      return id ? [id] : [];
    });
    const outboxes = new Map(
      (outboxIds.length
        ? await prisma.task.findMany({
            where: { projectId, id: { in: outboxIds } },
            select: { id: true, status: true, errorMessage: true },
          })
        : []
      ).map((task) => [task.id, task]),
    );
    const identityByDocument = new Map(
      docs.map((doc) => [
        doc.id,
        generatedDocSyntheticDocumentId(doc.id, doc.versions?.[0]?.revisionId),
      ]),
    );
    const syntheticDocuments = await prisma.document.findMany({
      where: {
        projectId,
        id: {
          in: [
            ...new Set([
              ...identityByDocument.values(),
              ...docs.map((doc) => generatedDocSyntheticDocumentId(doc.id)),
            ]),
          ],
        },
        deletedAt: null,
      },
      select: {
        id: true,
        indexState: true,
        status: true,
        chunkCount: true,
        errorMessage: true,
        processedAt: true,
      },
    });
    const indexByGeneratedDocId = new Map(
      syntheticDocuments.map((document) => [document.id, syntheticIndex(document)]),
    );
    const data = await Promise.all(
      docs.map(async (doc) => {
        const latest = doc.versions?.[0];
        const outbox = outboxes.get(publicationId(projectId, doc.id, latest) ?? "");
        return {
          ...doc,
          versions: doc.versions?.map(({ revisionId }) => ({ revisionId })),
          indexing:
            indexByGeneratedDocId.get(identityByDocument.get(doc.id)!) ??
            ((await canUseLegacyIndex(latest && rowKey(projectId, doc.id, latest), outbox))
              ? indexByGeneratedDocId.get(generatedDocSyntheticDocumentId(doc.id))
              : undefined) ??
            unpublishedIndex(outbox),
        };
      }),
    );
    res.json({ data });
  });

  // GET /:docId — get single document. #190 — the content once plus summary
  // metadata. Version bodies, provenance manifests and changed symbols can be
  // tens of megabytes for a full-coverage document, so each has its own
  // endpoint below and is fetched only when the viewer opens that panel.
  r.get("/:docId", requirePermission("project.read"), async (req: Request, res: Response) => {
    const projectId = getProjectId(req);
    const docId = getDocId(req);
    const doc = await prisma.generatedDocument.findFirst({
      where: { id: docId, projectId, deletedAt: null },
      select: {
        id: true,
        projectId: true,
        title: true,
        scope: true,
        scopeFilter: true,
        content: true,
        status: true,
        errorMessage: true,
        warnings: true,
        autoUpdate: true,
        generatedAt: true,
        createdAt: true,
        updatedAt: true,
        versions: {
          orderBy: { version: "desc" },
          take: 5,
          select: { id: true, version: true, revisionId: true, diffSummary: true, createdAt: true },
        },
      },
    });
    if (!doc) throw new AppError(404, "DOC_NOT_FOUND", "Generated document not found");
    const latest = doc.versions[0];
    const outboxId = publicationId(projectId, doc.id, latest);
    const outbox = outboxId
      ? await prisma.task.findUnique({
          where: { id: outboxId, projectId },
          select: { status: true, errorMessage: true },
        })
      : null;
    const indexingSelect = {
      indexState: true,
      status: true,
      chunkCount: true,
      errorMessage: true,
      processedAt: true,
    } as const;
    const syntheticDocument =
      (await prisma.document.findFirst({
        where: {
          id: generatedDocSyntheticDocumentId(doc.id, latest?.revisionId),
          projectId,
          deletedAt: null,
        },
        select: indexingSelect,
      })) ??
      (latest?.revisionId &&
      (await canUseLegacyIndex(rowKey(projectId, docId, latest), outbox ?? undefined))
        ? await prisma.document.findFirst({
            where: { id: generatedDocSyntheticDocumentId(doc.id), projectId, deletedAt: null },
            select: indexingSelect,
          })
        : null);
    const { content, versions, ...meta } = doc;
    res.json({
      data: {
        ...meta,
        content,
        contentLength: content.length,
        // #52 — never the raw exception text a pre-#52 row may still hold.
        errorMessage: publicGenerationErrorMessage(doc.status, doc.errorMessage),
        // #67 — same rule for the DEGRADED path: a `section-failed` warning
        // persisted before #67 appended up to 300 characters of `String(err)`
        // to its message, and this column was returned verbatim.
        warnings: publicDocWarnings(doc.warnings),
        // #50 — lets the UI explain a restart and offer a one-click regenerate.
        interrupted: doc.status === "failed" && doc.errorMessage === GENERATION_INTERRUPTED_MESSAGE,
        // #98 / #489 — same projection as the list handler.
        indexing: syntheticDocument ? syntheticIndex(syntheticDocument) : unpublishedIndex(outbox),
        versions: await Promise.all(
          versions.map(async (version) => ({
            id: version.id,
            version: version.version,
            revisionId: await versionRevisionId(projectId, docId, version),
            diffSummary: version.diffSummary,
            createdAt: version.createdAt,
          })),
        ),
      },
    });
  });

  // #190 — the heavy per-version fields, each behind its own request. The
  // router-level `requireProjectAccess` and the same `project.read` permission
  // as the detail route apply; the version is looked up through its document's
  // project, so a version id from another project or document is a 404.
  const findVersion = async <S extends Prisma.GeneratedDocumentVersionSelect>(
    req: Request,
    select: S,
  ) => {
    const projectId = getProjectId(req);
    const docId = getDocId(req);
    const versionId = Array.isArray(req.params.versionId)
      ? req.params.versionId[0]
      : req.params.versionId;
    const version = await prisma.generatedDocumentVersion.findFirst({
      where: { id: versionId, documentId: docId, document: { projectId, deletedAt: null } },
      select,
    });
    if (!version) throw new AppError(404, "DOC_VERSION_NOT_FOUND", "Document version not found");
    return { projectId, docId, version };
  };

  // GET /:docId/versions/:versionId — one version's full markdown body.
  r.get(
    "/:docId/versions/:versionId",
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const { projectId, docId, version } = await findVersion(req, {
        id: true,
        version: true,
        revisionId: true,
        diffSummary: true,
        createdAt: true,
        content: true,
      });
      res.json({
        data: { ...version, revisionId: await versionRevisionId(projectId, docId, version) },
      });
    },
  );

  // GET /:docId/versions/:versionId/provenance — the version's provenance manifest.
  r.get(
    "/:docId/versions/:versionId/provenance",
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const { projectId, docId, version } = await findVersion(req, {
        version: true,
        provenanceManifest: true,
      });
      let manifest;
      try {
        manifest = version.provenanceManifest
          ? parseGeneratedDocVersionManifest(version.provenanceManifest)
          : legacyGeneratedDocVersionManifest({
              projectId,
              generatedDocumentId: docId,
              version: version.version,
            });
      } catch {
        throw new AppError(500, "PROVENANCE_CORRUPT", "Stored provenance manifest is not readable");
      }
      res.json({ data: manifest });
    },
  );

  // GET /:docId/versions/:versionId/provenance/summary — #196: the handful of
  // fields the Provenance panel shows. The full manifest above is only fetched
  // when the user asks to download it.
  r.get(
    "/:docId/versions/:versionId/provenance/summary",
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const { projectId, docId, version } = await findVersion(req, {
        id: true,
        version: true,
        createdAt: true,
      });
      const summary = await versionSummary(rowKey(projectId, docId, version));
      if (!summary) {
        throw new AppError(500, "PROVENANCE_CORRUPT", "Stored provenance manifest is not readable");
      }
      res.json({ data: summary });
    },
  );

  // GET /:docId/versions/:versionId/changed-symbols?offset=&limit= — a page of
  // the symbols the version regenerated, with the total. #196 — the stored
  // array is parsed once per version and paged from the cache after that.
  const changedSymbolsQuery = z.object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(5000).default(500),
  });
  r.get(
    "/:docId/versions/:versionId/changed-symbols",
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const page = changedSymbolsQuery.safeParse(req.query);
      if (!page.success) throw new AppError(400, "VALIDATION_ERROR", page.error.message);
      const { projectId, docId, version } = await findVersion(req, {
        id: true,
        version: true,
        createdAt: true,
      });
      const symbols = await cachedChangedSymbols(rowKey(projectId, docId, version), async () => {
        const stored = await prisma.generatedDocumentVersion.findFirst({
          where: { id: version.id, documentId: docId },
          select: { changedSymbols: true },
        });
        return stored?.changedSymbols ?? "[]";
      });
      if (!symbols) {
        throw new AppError(
          500,
          "CHANGED_SYMBOLS_CORRUPT",
          "Stored changed symbols are not readable",
        );
      }
      const { offset, limit } = page.data;
      res.json({
        data: { total: symbols.length, offset, items: symbols.slice(offset, offset + limit) },
      });
    },
  );

  // GET /:docId/export — export PDF, Word, or Markdown
  r.get(
    "/:docId/export",
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = getProjectId(req);
      const docId = getDocId(req);
      const format = z.enum(["pdf", "docx", "markdown"]).safeParse(req.query.format);
      if (!format.success) {
        throw new AppError(400, "INVALID_FORMAT", "format must be pdf, docx, or markdown");
      }

      // #225 — `degraded` docs still carry full, exportable content (they are
      // just flagged for failed/ungrounded sections), so allow export of both
      // `ready` and `degraded`.
      const doc = await prisma.generatedDocument.findFirst({
        where: { id: docId, projectId, deletedAt: null, status: { in: ["ready", "degraded"] } },
      });
      if (!doc) throw new AppError(404, "DOC_NOT_FOUND", "Document not found or not ready");

      // #619 — approval gate: with `requireApprovedReview` on, a spec may
      // only be exported when an approved review pins its current version.
      // Throws 409 APPROVAL_REQUIRED / 503 on gate failure (fail-closed).
      await assertDocumentExportable({
        projectId,
        documentId: docId,
        context: "docs.export",
        actorId: req.user?.userId,
      });

      const { exportDocument } = await import("../lib/docs-gen/exporters.js");
      const result = await exportDocument(doc.content, doc.title, format.data);

      res.setHeader("Content-Type", result.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- `result.buffer` is a generated binary document (PDF/DOCX), not HTML; the explicit binary Content-Type, attachment disposition, and nosniff header prevent any HTML interpretation.
      res.send(result.buffer);
    },
  );

  // GET /:docId/schema-graph — structured schema graph for the explorer (Epic #895)
  r.get(
    "/:docId/schema-graph",
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = getProjectId(req);
      const docId = getDocId(req);

      const doc = await prisma.generatedDocument.findFirst({
        where: { id: docId, projectId, deletedAt: null },
        select: { schemaGraph: true },
      });
      if (!doc) throw new AppError(404, "DOC_NOT_FOUND", "Document not found");
      if (!doc.schemaGraph) {
        throw new AppError(404, "SCHEMA_GRAPH_NOT_FOUND", "No schema graph for this document");
      }

      let graph: SchemaGraph;
      try {
        graph = JSON.parse(doc.schemaGraph) as SchemaGraph;
      } catch {
        throw new AppError(500, "SCHEMA_GRAPH_CORRUPT", "Stored schema graph is not valid JSON");
      }

      res.json({ data: graph });
    },
  );

  // PATCH /:docId — update metadata
  r.patch("/:docId", requirePermission("project.update"), async (req: Request, res: Response) => {
    const projectId = getProjectId(req);
    const docId = getDocId(req);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", parsed.error.message);
    }

    const existing = await prisma.generatedDocument.findFirst({
      where: { id: docId, projectId, deletedAt: null },
    });
    if (!existing) throw new AppError(404, "DOC_NOT_FOUND", "Document not found");

    const updated = await prisma.generatedDocument.update({
      where: { id: docId },
      data: parsed.data,
    });
    // #782 — the generation checkpoint is internal resume state, never a response field.
    const { generationCheckpoint: _checkpoint, ...row } = updated;
    res.json({
      data: {
        ...row,
        errorMessage: publicGenerationErrorMessage(row.status, row.errorMessage),
        // #67 — see the GET handler: the row's warnings column is the degraded
        // path's equivalent of `errorMessage` and gets the same treatment.
        warnings: publicDocWarnings(row.warnings),
      },
    });
  });

  // POST /:docId/regenerate — #50: one-click regenerate of a FAILED document in
  // place (e.g. one interrupted by a restart). Shares /generate's rate limit.
  r.post(
    "/:docId/regenerate",
    generateRateLimiter,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const projectId = getProjectId(req);
      const docId = getDocId(req);
      // Compare-and-set failed → pending: a double click or a concurrent request
      // starts exactly one generation. `pending` is what generateDocumentAsync's
      // pre-claim failure path fences on, and what the UI shows until it claims.
      // #782 — and a degraded document that never published a version: that is
      // a run that stopped early and kept its finished sections, which a
      // regenerate completes (reusing them).
      const reset = await prisma.generatedDocument.updateMany({
        where: {
          id: docId,
          projectId,
          deletedAt: null,
          // #855 — and a cancelled one, which resumes from its checkpoint.
          OR: [
            { status: "failed" },
            { status: "cancelled" },
            { status: "degraded", versions: { none: {} } },
          ],
        },
        data: { status: "pending", errorMessage: null },
      });
      if (!reset.count) {
        const existing = await prisma.generatedDocument.findFirst({
          where: { id: docId, projectId, deletedAt: null },
          select: { status: true },
        });
        if (!existing) throw new AppError(404, "DOC_NOT_FOUND", "Generated document not found");
        throw new AppError(
          409,
          "DOC_NOT_REGENERATABLE",
          `Only a failed, cancelled or partially generated document can be regenerated (status: ${existing.status})`,
        );
      }
      void generateDocumentAsync(docId, projectId).catch((err) => {
        log.error("Background doc regeneration failed", { err, docId });
      });
      res.status(202).json({ data: { id: docId, status: "pending" } });
    },
  );

  // POST /:docId/cancel — #855: stop a generation that is spending money.
  // Behind the router-level pre-auth and per-user limiters, like every route
  // here; deliberately NOT behind the generate limiter, so a user who has spent
  // their generate budget can still stop a run.
  r.post(
    "/:docId/cancel",
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const projectId = getProjectId(req);
      const docId = getDocId(req);
      // Not yet claimed: nothing is running, so it is cancelled outright (the
      // claim compare-and-sets on this row's updatedAt, which this changes).
      const queued = await prisma.generatedDocument.updateMany({
        where: { id: docId, projectId, deletedAt: null, status: "pending" },
        data: { status: "cancelled", errorMessage: GENERATION_CANCELLED_MESSAGE },
      });
      if (queued.count) {
        jobEvents.completed("doc-generation", docId, projectId, "Generation cancelled");
        res.status(200).json({ data: { id: docId, status: "cancelled" } });
        return;
      }
      // Running: mark it, then stop it. A run in this process stops at once;
      // one on another replica notices on its next heartbeat. The run itself
      // records the final `cancelled` state, keeping what it finished.
      const running = await prisma.generatedDocument.updateMany({
        where: { id: docId, projectId, deletedAt: null, status: "generating" },
        data: { status: "cancelling" },
      });
      if (running.count) {
        stopGeneration(docId, "aborted");
        log.info("Generation cancel requested", { docId, projectId, userId: req.user?.userId });
        res.status(202).json({ data: { id: docId, status: "cancelling" } });
        return;
      }
      const existing = await prisma.generatedDocument.findFirst({
        where: { id: docId, projectId, deletedAt: null },
        select: { status: true },
      });
      if (!existing) throw new AppError(404, "DOC_NOT_FOUND", "Generated document not found");
      if (existing.status === "cancelling") {
        // Idempotent: a second click while the first is taking effect.
        stopGeneration(docId, "aborted");
        res.status(202).json({ data: { id: docId, status: "cancelling" } });
        return;
      }
      if (["cancelled", "ready", "degraded", "failed"].includes(existing.status)) {
        // #867 — idempotent: nothing is running. A second click that races the
        // run's own final write (`cancelled`), or the published state a run
        // cancelled over a published version restores.
        res.status(200).json({ data: { id: docId, status: existing.status } });
        return;
      }
      throw new AppError(
        409,
        "DOC_NOT_CANCELLABLE",
        `Only a pending or generating document can be cancelled (status: ${existing.status})`,
      );
    },
  );

  // DELETE /:docId — soft delete
  r.delete("/:docId", requirePermission("project.update"), async (req: Request, res: Response) => {
    const projectId = getProjectId(req);
    const docId = getDocId(req);
    const tasks = await prisma.$transaction(async (tx) => {
      // A same-project tombstone is an idempotent retry, not a missing artifact.
      const existing = await tx.generatedDocument.findFirst({
        where: { id: docId, projectId },
      });
      if (!existing) throw new AppError(404, "DOC_NOT_FOUND", "Document not found");
      // Acquire the source row's write lock before enumerating versions. Generation
      // uses the same row and deletedAt fence, so it cannot commit behind deletion.
      await tx.generatedDocument.update({
        where: { id: docId },
        data: { deletedAt: existing.deletedAt ?? new Date() },
      });
      const ids: string[] = [];
      let beforeVersion: number | undefined;
      while (true) {
        const version = await tx.generatedDocumentVersion.findFirst({
          where: {
            documentId: docId,
            ...(beforeVersion !== undefined ? { version: { lt: beforeVersion } } : {}),
          },
          orderBy: { version: "desc" },
          select: { version: true, revisionId: true, provenanceManifest: true },
        });
        if (!version) break;
        beforeVersion = version.version;
        const revisionId =
          version.revisionId ??
          (version.provenanceManifest
            ? parseGeneratedDocVersionManifest(version.provenanceManifest).revision.revisionId
            : generatedDocRevisionId({
                projectId,
                generatedDocumentId: docId,
                version: version.version,
              }));
        ids.push(
          await persistGeneratedDocTask(
            tx,
            { projectId, generatedDocumentId: docId, version: version.version, revisionId },
            req.user?.userId ?? null,
            "delete",
          ),
        );
      }
      // Even pre-version legacy artifacts may own the old shared synthetic ID.
      if (!ids.length) {
        ids.push(
          await persistGeneratedDocTask(
            tx,
            {
              projectId,
              generatedDocumentId: docId,
              version: 1,
              revisionId: generatedDocRevisionId({
                projectId,
                generatedDocumentId: docId,
                version: 1,
              }),
            },
            req.user?.userId ?? null,
            "delete",
          ),
        );
      }
      return ids;
    });
    // #855 — deleting a generating document stops its spend, not only its
    // commit: a run in this process is aborted now, one on another replica on
    // its next heartbeat (which finds the row deleted).
    stopGeneration(docId, "superseded");
    for (const id of tasks) await dispatchGeneratedDocTask(id);
    res.status(204).send();
  });

  return r;
}

/**
 * #856 — how often a batched section re-checks its inputs between batches.
 * Capturing the inputs reads the code graph and the source files, so it is not
 * done before every one of a section's batches.
 */
const INPUTS_RECHECK_MS = 5 * 60_000;

/** #857 — the version note for a run that had stored sections to reuse. */
function resumeSummary(resume: SectionResumeReport): string {
  const stale = resume.stale
    .slice(0, 10)
    .map((s) => `${s.section} (${s.changed.join(", ") || "inputs"})`)
    .join("; ");
  return [
    `Reused ${resume.reused.length} finished section${resume.reused.length === 1 ? "" : "s"}`,
    ...(resume.stale.length > 0
      ? [
          `rewrote ${resume.stale.length} whose inputs changed: ${stale}${resume.stale.length > 10 ? "; …" : ""}`,
        ]
      : []),
  ].join("; ");
}

/**
 * Background document generation. Updates the doc row with status transitions.
 */
export async function generateDocumentAsync(
  docId: string,
  projectId: string,
  automatic?: RegenerationTask & { signal: AbortSignal },
): Promise<void> {
  const claim = `regenerating:${randomUUID()}`;
  let claimed = false;
  let originalHash: string | null = null;
  // #867 — what a cancelled run puts back over a published version: the row's
  // state when the run read it, when that was a settled one.
  let restoreOnCancel:
    | {
        status: string;
        errorMessage: string | null;
        warnings: Prisma.InputJsonValue | typeof Prisma.DbNull;
      }
    | undefined;
  let pendingUpdatedAt: Date | undefined;
  // #50 — refreshes the row while this run holds its claim; a stopped heartbeat
  // is how the interrupted-generation sweep tells a dead run from a live one.
  let stopHeartbeat: (() => void) | undefined;
  // #782 — where the run is, so a failure can say so on the document; and what
  // it has finished, so a late failure does not discard it.
  let stage: GenerationStage = "setup";
  let stageSection: string | undefined;
  let hadVersion = false;
  let title = "Generated Documentation";
  let finishedSections: SectionSynthesisRecord[] = [];
  let synthesized: { markdown: string; warnings: DocWarningShape[] } | undefined;
  // #855 — this run's stop switch and cost ceiling, from the moment it claims.
  let control: GenerationControl | undefined;
  let beforeStep: GenerationStepHook | undefined;
  // #857 — what a resumed run reused and rewrote.
  let resume: SectionResumeReport | undefined;
  try {
    if (automatic?.signal.aborted)
      throw new UnpublishableGenerationError("aborted", "Regeneration aborted");
    const original = await prisma.generatedDocument.findFirst({
      where: { id: docId, projectId, deletedAt: null },
    });
    if (!original || (automatic && !original.autoUpdate)) return;
    // #855 — cancelled before this run read the row: nothing to do.
    if (!automatic && original.status === "cancelled") return;
    originalHash = original.codeGraphHash;
    if (["ready", "degraded", "failed", "cancelled"].includes(original.status))
      restoreOnCancel = {
        status: original.status,
        errorMessage: original.errorMessage,
        warnings: (original.warnings ?? Prisma.DbNull) as Prisma.InputJsonValue,
      };
    if (!automatic && original.status === "pending") pendingUpdatedAt = original.updatedAt;
    const policy = await resolveEvidencePolicy(original);
    const lastVersion = await prisma.generatedDocumentVersion.findFirst({
      where: { documentId: docId },
      orderBy: { version: "desc" },
    });
    // #867 — a document the user cancelled before it ever published is not
    // restarted by an ingest; only a regenerate does that. One with a published
    // version keeps tracking, as a failed one does.
    if (automatic && original.status === "cancelled" && !lastVersion) return;
    if (automatic && (lastVersion?.version ?? 0) !== automatic.expectedVersion) {
      if (
        lastVersion?.version === automatic.expectedVersion + 1 &&
        lastVersion.provenanceManifest &&
        parseGeneratedDocVersionManifest(lastVersion.provenanceManifest).inputSnapshot
          ?.fingerprint === automatic.fingerprint
      ) {
        await dispatchGeneratedDocTask(
          generatedDocOutboxId({
            projectId,
            generatedDocumentId: docId,
            version: lastVersion.version,
            revisionId:
              lastVersion.revisionId ??
              generatedDocRevisionId({
                projectId,
                generatedDocumentId: docId,
                version: lastVersion.version,
              }),
          }),
        );
        return;
      }
      const { checkIncrementalRegeneration } = await import("../lib/docs-gen/incremental.js");
      await checkIncrementalRegeneration(projectId, policy.repoConnectorId);
      return;
    }
    let inputSnapshot: GenerationInputSnapshot | null =
      original.scope === "database" ? null : await captureGenerationInputs(original, policy);
    if (automatic && inputSnapshot?.fingerprint !== automatic.fingerprint) {
      const { checkIncrementalRegeneration } = await import("../lib/docs-gen/incremental.js");
      await checkIncrementalRegeneration(projectId, policy.repoConnectorId);
      return;
    }
    const previousManifest = lastVersion?.provenanceManifest
      ? parseGeneratedDocVersionManifest(lastVersion.provenanceManifest)
      : undefined;
    const previous = previousManifest?.inputSnapshot ?? null;
    const plan = inputSnapshot ? planRegeneration(previous, inputSnapshot) : null;
    if (automatic && plan?.mode === "unchanged") return;
    const acquired = await prisma.generatedDocument.updateMany({
      where: {
        id: docId,
        projectId,
        deletedAt: null,
        updatedAt: original.updatedAt,
        versions: { none: { version: { gt: lastVersion?.version ?? 0 } } },
        // #867 — `cancelling` is live too: a run winding down after a cancel
        // must not be taken over by another (it would turn the cancel into a
        // fresh run). A row stuck in either state for two hours has no run.
        OR: [
          { status: { notIn: ["generating", "cancelling"] } },
          { updatedAt: { lt: new Date(Date.now() - 7_200_000) } },
        ],
        ...(automatic ? { autoUpdate: true } : {}),
      },
      data: { status: "generating", codeGraphHash: claim },
    });
    if (!acquired.count) throw new Error("Generation already running or revision changed");
    claimed = true;
    hadVersion = lastVersion != null;
    title = original.title || title;
    const run = startGenerationControl(docId, projectId);
    control = run;
    // An automatic run's own abort (its task cancelled) stops it the same way.
    automatic?.signal.addEventListener("abort", () => run.stop("aborted"), { once: true });
    stopHeartbeat = startGenerationHeartbeat(docId, projectId, claim, undefined, (reason) =>
      run.stop(reason),
    );
    // #856 — between units of work, not only at the commit fence: a run whose
    // row was cancelled, deleted or taken, or whose inputs changed, stops
    // before it spends more. Batches are checked at most every
    // INPUTS_RECHECK_MS (a batched section can run for 25 minutes); every
    // other step always is. With a same-SHA refresh made a no-op on the ingest
    // side the inputs simply never differ here, so this costs one read.
    let lastInputsCheck = 0;
    beforeStep = async (step) => {
      const stopped = run.stopError();
      if (stopped) throw stopped;
      const now = Date.now();
      if (step.kind === "batch" && now - lastInputsCheck < INPUTS_RECHECK_MS) return;
      lastInputsCheck = now;
      const row = await prisma.generatedDocument.findFirst({
        where: { id: docId, projectId, deletedAt: null },
      });
      if (!row || row.codeGraphHash !== claim) run.stop("superseded");
      else if (row.status === "cancelling") run.stop("aborted");
      else if (
        inputSnapshot &&
        (await captureGenerationInputs(row, await resolveEvidencePolicy(row))).fingerprint !==
          inputSnapshot.fingerprint
      ) {
        log.warn("Generation inputs changed mid-run; stopping it", {
          docId,
          projectId,
          step: step.kind,
          section: step.section,
        });
        run.stop("inputs-changed");
      }
      const reason = run.stopError();
      if (reason) throw reason;
    };
    // #239 — broadcast the doc-generation job start so the UI flips from the
    // static "generating" badge to live status without a manual refresh.
    jobEvents.started("doc-generation", docId, projectId, "Generating documentation");

    const { DISCOVERY_SUMMARY_PROMPT_VERSION, resolveDiscoveryGenerationModel, runDiscoveryAgent } =
      await import("../lib/docs-gen/discovery-agent.js");
    const { synthesizeHolisticDocument } = await import("../lib/docs-gen/holistic-synthesizer.js");
    const { DB_SCHEMA_PROSE_PROMPT_VERSION, synthesizeDbSchemaDocument } =
      await import("../lib/docs-gen/db-schema-synthesizer.js");
    const { deriveDocStatus } = await import("../lib/docs-gen/grounding/degraded-warnings.js");
    type DocType = "business-requirements" | "architecture" | "user-guide";
    type DocWarning = import("../lib/docs-gen/grounding/degraded-warnings.js").DocWarning;
    const { assembleDocument } = await import("../lib/docs-gen/assembler.js");

    // For full-project and repository docs use the holistic synthesizer.
    // For database scope use the DB schema synthesizer.
    // For narrow scopes fall back to per-symbol discovery + assembler.
    const doc = await prisma.generatedDocument.findFirst({
      where: { id: docId, projectId, deletedAt: null },
    });
    if (!doc) throw new AppError(404, "DOC_NOT_FOUND", "Generated document not found");
    let markdown: string;
    // #225 — degraded-output warnings surfaced from synthesis (failed sections).
    let docWarnings: DocWarning[] = [];
    // Structured schema-graph JSON persisted for database-scope docs (Epic #895).
    let schemaGraphJson: string | null = null;
    let selectedEvidence: import("../lib/docs-gen/grounding/grounding-context.js").GroundingSource[] =
      [];
    let manifestSections: Array<{
      sectionLabel: string;
      sectionIndex: number;
      providerKind: "bedrock" | "local" | "anthropic";
      model: string;
      factsSourceIds: string[];
      groundingSourceIds: string[];
    }> = [];
    let synthesizedProvenanceManifest: string | null = null;
    let fallbackGenerationPipeline:
      "holistic" | "incremental-discovery" | "discovery-agent" | "database-schema" | undefined;
    let fallbackGenerationModels:
      | {
          phase1: string;
          phase2: string;
          claim: string;
          judge: string;
        }
      | undefined;
    let fallbackPhase1PromptVersion = PHASE1_PROMPT_VERSION;
    let fallbackSourceFingerprints:
      | Array<{
          kind: "repository-graph" | "project-scope" | "database-schema";
          repoConnectorId: string | null;
          codeGraphId: string | null;
          dbConnectorId?: string | null;
          commitSha?: string | null;
          sourceFingerprint: string;
        }>
      | undefined;
    let fallbackGraphFingerprint: string | null | undefined;
    let fallbackSourceRepositories:
      | Array<
          | {
              codeGraphId: string;
              repoConnectorId: string | null;
            }
          | undefined
        >
      | undefined =
      policy.codeGraphId || policy.repoConnectorId
        ? [
            {
              codeGraphId: policy.codeGraphId ?? "unknown",
              repoConnectorId: policy.repoConnectorId ?? null,
            },
          ]
        : [undefined];

    const nextVersion = (lastVersion?.version ?? 0) + 1;
    const generatedAt = new Date();

    // Parse scopeFilter once
    let filter: Record<string, unknown> = {};
    try {
      filter = JSON.parse(doc?.scopeFilter ?? "{}") as Record<string, unknown>;
    } catch {
      // ignore — keep empty
    }

    if (doc?.scope === "database") {
      fallbackGenerationPipeline = "database-schema";
      const dbConnectorId = typeof filter.dbConnectorId === "string" ? filter.dbConnectorId : "";
      const actorId = policy.actor.userId;
      // #858 — in the run's scope like the holistic path (#855): the prose calls
      // carry its AbortSignal, a cancel stops them, and their spend counts
      // against the run's ceiling.
      const result = await withGenerationScope(control!, () =>
        synthesizeDbSchemaDocument(
          projectId,
          dbConnectorId,
          actorId,
          doc.title ?? "Database Schema",
        ),
      );
      markdown = result.markdown;
      schemaGraphJson = result.schemaGraph ? JSON.stringify(result.schemaGraph) : null;
      fallbackGenerationModels = {
        phase1: "not-applicable",
        phase2: result.generationModel ?? "not-applicable",
        claim: "not-applicable",
        judge: "not-applicable",
      };
      fallbackPhase1PromptVersion = DB_SCHEMA_PROSE_PROMPT_VERSION;
      fallbackSourceRepositories = [];
      fallbackSourceFingerprints = [
        {
          kind: "database-schema",
          repoConnectorId: null,
          codeGraphId: null,
          dbConnectorId: dbConnectorId || null,
          sourceFingerprint: databaseSourceFingerprintOf({
            dbConnectorId: dbConnectorId || null,
            schemaGraph: result.schemaGraph,
          }),
        },
      ];
      fallbackGraphFingerprint = graphFingerprintOfValue(result.schemaGraph);
      // #1228 — a DB-schema doc whose table prose all failed used to reach
      // `ready` with `warnings = NULL`. Feed the synthesizer's warnings into the
      // same `deriveDocStatus` path every other scope already uses.
      docWarnings = result.warnings;
    } else if (doc?.scope === "full" || doc?.scope === "repository") {
      let docType: DocType = "business-requirements";
      if (
        filter.docType === "business-requirements" ||
        filter.docType === "architecture" ||
        filter.docType === "user-guide"
      ) {
        docType = filter.docType as DocType;
      }
      const repoConnectorId = policy.repoConnectorId;
      const pathPrefixes = readStoredPathScope(filter) ?? undefined;

      // #283 — opt-in domain web-research grounding. When enabled on the
      // Generate Documentation flow, run the existing WebResearchAugmenter for
      // the project's domain/overview topic and persist the digests BEFORE the
      // grounding retrievers below read them, so the per-section grounding set
      // includes domain context (Acme Freight / DOT etc.). Awaited but best-effort: a
      // failure logs + proceeds ungrounded, NEVER failing doc generation. Off by
      // default → no surprise network calls / cost.
      if (policy.allowWebResearch) {
        try {
          const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { name: true, description: true },
          });
          const { buildProvider, loadAIConfig } = await import("../lib/ai/index.js");
          const { runDomainWebResearch } =
            await import("../lib/docs-gen/grounding/domain-web-research.js");
          await runDomainWebResearch(
            {
              projectId,
              projectName: project?.name ?? "Project",
              projectDescription: project?.description ?? null,
              docTitle: doc?.title ?? docType.replace(/-/g, " "),
              actorId: policy.actor.userId,
            },
            { provider: buildProvider({ config: loadAIConfig() }) },
          );
        } catch (err) {
          // Defence in depth: even constructing the augmenter must not fail gen.
          log.warn("Domain web research setup failed; continuing ungrounded", {
            err: String(err),
            docId,
          });
        }
      }

      // #222 — retrieve grounding evidence (RAG chunks + web-research digests)
      // and inject it into synthesis. Best-effort: a failure here yields an
      // empty context and ungrounded (but still produced) output.
      // #264 — also build a PER-SECTION retriever so each section group is
      // grounded against sources retrieved for its own topic, not one doc-level
      // title query. The doc-level context is kept as a back-compat fallback.
      const { buildProjectGroundingContext, buildSectionGroundingRetriever } =
        await import("../lib/docs-gen/grounding/grounding-retrieval.js");
      // Web research above may have added evidence. Snapshot before any synthesis
      // or retrieval consumes it, never after generating the content.
      if (policy.allowWebResearch) {
        const afterResearch = await captureGenerationInputs(doc, policy);
        if (
          inputSnapshot &&
          Object.keys({ ...inputSnapshot.items, ...afterResearch.items }).some(
            (key) => key !== "web" && inputSnapshot!.items[key] !== afterResearch.items[key],
          )
        ) {
          throw new Error("Generation inputs changed during web research");
        }
        inputSnapshot = afterResearch;
      }
      const grounding = await buildProjectGroundingContext({
        projectId,
        policy,
        query: `${doc?.title ?? ""} ${docType.replace(/-/g, " ")}`.trim(),
        ...(pathPrefixes ? { pathPrefixes } : {}),
      });
      selectedEvidence = grounding?.sources ?? [];
      const groundingForSection = buildSectionGroundingRetriever({
        projectId,
        policy,
        ...(pathPrefixes ? { pathPrefixes } : {}),
      });

      // #178 — the bar never moves backwards: a batched section's total grows
      // when a cut-off batch is split, which can lower done/total for a moment.
      const docPercent = monotonicPercent();
      // #855 — inside the run's scope: every docs-gen provider call carries its
      // AbortSignal and reports its spend to the run's ceiling.
      const result = await withGenerationScope(control!, () =>
        synthesizeHolisticDocument(projectId, docType, doc?.title ?? "Generated Documentation", {
          ...(automatic ? { previousManifest } : {}),
          ...(beforeStep ? { beforeStep } : {}),
          // #782 — resume: an earlier unfinished run's sections are reused
          // where their inputs are unchanged, and this run's are saved as each
          // one finishes, only while this run still holds the claim. `records`
          // is already merged with the stored checkpoint (sections this run has
          // not reached are carried), so it replaces the column, and a late
          // failure's partial document is built from all of it.
          checkpoint: original.generationCheckpoint ?? undefined,
          onCheckpoint: async (records) => {
            finishedSections = records;
            await prisma.generatedDocument.updateMany({
              where: { id: docId, projectId, deletedAt: null, codeGraphHash: claim },
              data: {
                generationCheckpoint: buildGenerationCheckpoint(
                  records,
                ) as unknown as Prisma.InputJsonValue,
              },
            });
          },
          provenance: {
            revision: {
              projectId,
              generatedDocumentId: docId,
              version: nextVersion,
            },
            generatedAt,
            policy,
          },
          ...(repoConnectorId ? { repoConnectorId } : {}),
          ...(pathPrefixes ? { pathPrefixes } : {}),
          ...(grounding ? { grounding } : {}),
          groundingForSection,
          // #243 — per-section live progress + degraded/failed warnings.
          onSectionProgress: (u) => {
            // The last section's terminal update ends the section stage: what
            // follows (assembly, provenance) is not "in" that section.
            const last =
              (u.status === "done" || u.status === "degraded" || u.status === "failed") &&
              u.index >= u.total;
            stage = last ? "assembly" : "sections";
            // #856 — between sections the run is in none of them: a stop found
            // before the next one must not be blamed on the one just finished.
            stageSection = last || u.status !== "generating" ? undefined : u.section;
            jobEvents.docSection({
              jobId: docId,
              projectId,
              section: u.section,
              status: u.status,
              index: u.index,
              total: u.total,
              warning: u.warning
                ? {
                    kind: u.warning.kind,
                    severity: u.warning.severity,
                    message: u.warning.message,
                  }
                : undefined,
            });
            // Mirror progress onto the lifecycle channel (0-100): Phase 2 fills
            // PHASE1_PROGRESS_SHARE..100, and a batched section advances once
            // per batch, not once per section.
            jobEvents.progress(
              "doc-generation",
              docId,
              projectId,
              docPercent(documentProgressPercent(u)),
              sectionProgressMessage(u),
            );
          },
          // Phase 1 fills the first PHASE1_PROGRESS_SHARE of the bar, per chunk.
          onPhase1Progress: ({ done, total }) => {
            stage = "facts";
            jobEvents.progress(
              "doc-generation",
              docId,
              projectId,
              docPercent(phase1ProgressPercent(done, total)),
              phase1ProgressMessage(done, total),
            );
          },
        }),
      );
      stage = "assembly";
      stageSection = undefined;
      markdown = result.markdown;
      resume = result.resume;
      if (resume) log.info("Resumed from stored sections", { docId, projectId, ...resume });
      // #182 — sections were grounded against the repository index; when that
      // index is partial (capped, failed, interrupted, never recorded), say so,
      // so the document is `degraded` rather than looking fully grounded.
      // #217 — likewise when a file skipped as oversize lies in this document's
      // scope (the repository, or its pathPrefixes).
      const { repositoryIndexWarnings } = await import("../lib/connectors/source-ingest-state.js");
      docWarnings = [
        ...result.warnings,
        ...(await repositoryIndexWarnings(projectId, {
          ...(repoConnectorId ? { repoConnectorId } : {}),
          ...(pathPrefixes ? { pathPrefixes } : {}),
        })),
      ];
      // #782 — the whole document exists from here: a failure below keeps it.
      synthesized = { markdown, warnings: docWarnings };
      synthesizedProvenanceManifest = result.provenanceManifest ?? null;
      manifestSections = result.provenanceManifest
        ? ((JSON.parse(result.provenanceManifest) as { sections?: typeof manifestSections })
            .sections ?? [])
        : [];
    } else {
      fallbackGenerationPipeline = "discovery-agent";
      fallbackGenerationModels = {
        phase1: "not-applicable",
        phase2: resolveDiscoveryGenerationModel(),
        claim: "not-applicable",
        judge: "not-applicable",
      };
      fallbackPhase1PromptVersion = DISCOVERY_SUMMARY_PROMPT_VERSION;
      fallbackSourceRepositories = [undefined];
      const sections = await runDiscoveryAgent(projectId);
      markdown = assembleDocument(sections, { projectId, title: doc?.title });
    }

    const phase1 = buildDocsGenProvider(1, 1);
    const phase2Router = resolvePhase2Router(1);
    const symbols = await prisma.codeSymbol.findMany({
      where: { projectId },
      select: { contentHash: true },
      orderBy: { qualifiedName: "asc" },
    });
    const revisionId = generatedDocRevisionId({
      projectId,
      generatedDocumentId: docId,
      version: nextVersion,
    });

    const baseProvenanceManifest =
      synthesizedProvenanceManifest ??
      buildGeneratedDocVersionManifest({
        revision: {
          projectId,
          generatedDocumentId: docId,
          version: nextVersion,
        },
        title: doc.title,
        scope: doc.scope,
        docType:
          doc.scope === "full" || doc.scope === "repository"
            ? ((filter.docType === "business-requirements" ||
              filter.docType === "architecture" ||
              filter.docType === "user-guide"
                ? filter.docType
                : null) as "business-requirements" | "architecture" | "user-guide" | null)
            : null,
        generatedAt,
        policy,
        phase1Tuning: phase1.tuning,
        phase2Router,
        phase1PromptVersion: fallbackPhase1PromptVersion,
        generationPipeline: fallbackGenerationPipeline,
        generationModels: fallbackGenerationModels,
        selectedEvidence,
        graphFingerprint:
          fallbackGraphFingerprint ??
          graphFingerprintOf(symbols.map((symbol) => symbol.contentHash)),
        sourceFingerprints: fallbackSourceFingerprints,
        sourceRepositories: fallbackSourceRepositories ?? [undefined],
        sections: manifestSections,
      });

    const synthesizedManifest = parseGeneratedDocVersionManifest(baseProvenanceManifest);
    // Only the actual synthesizer can prove complete section dependencies. A
    // source inventory delta or a citation list alone cannot justify reuse.
    const regeneration =
      automatic && plan
        ? synthesizedManifest.regeneration?.mode === "sections" ||
          synthesizedManifest.regeneration?.mode === "unchanged"
          ? { ...synthesizedManifest.regeneration, changed: plan.changed }
          : plan.mode === "full"
            ? plan
            : synthesizedManifest.regeneration
        : undefined;
    const provenanceManifest = JSON.stringify({
      ...synthesizedManifest,
      ...(inputSnapshot ? { inputSnapshot } : {}),
      ...(regeneration ? { regeneration } : {}),
    });

    // Compute code graph hash
    const { createHash } = await import("node:crypto");
    const codeGraphHash = createHash("sha256")
      .update(symbols.map((s) => s.contentHash).join(""))
      .digest("hex");

    // #225 — never report a clean `ready` when sections were degraded/failed.
    // The doc status reflects grounding/generation health.
    // #252 — structured warnings now live in their own `warnings` JSON column
    // (not the overloaded `errorMessage` field). `errorMessage` is reserved for
    // genuine error strings (the catch branch below); it is cleared here on a
    // successful (possibly degraded) generation.
    const healthStatus = deriveDocStatus(docWarnings);
    stage = "commit";
    // Revalidate both authorization and inputs at the commit boundary. A deleted,
    // superseded or concurrently changed job must never publish old content.
    const current = await prisma.generatedDocument.findFirst({
      where: { id: docId, projectId, deletedAt: null },
    });
    if (!current || current.codeGraphHash !== claim) return;
    // #855 — a cancel that landed after the last section still wins.
    if (current.status === "cancelling") control?.stop("aborted");
    const stopped = control?.stopError();
    if (stopped) throw stopped;
    const currentPolicy = await resolveEvidencePolicy(current);
    if (automatic?.signal.aborted)
      throw new UnpublishableGenerationError("aborted", "Regeneration aborted");
    if (
      inputSnapshot &&
      (await captureGenerationInputs(current, currentPolicy)).fingerprint !==
        inputSnapshot.fingerprint
    ) {
      throw new UnpublishableGenerationError(
        "inputs-changed",
        "Generation inputs changed; replay ingestion to regenerate the current revision",
      );
    }
    const publicationTaskId = await prisma.$transaction(async (tx) => {
      const committed = await tx.generatedDocument.updateMany({
        where: {
          id: docId,
          projectId,
          deletedAt: null,
          codeGraphHash: claim,
          // #855 — never publish over a cancel requested since the check above.
          status: "generating",
          scopeFilter: original.scopeFilter,
          evidencePolicy: original.evidencePolicy,
          title: original.title,
          versions: { none: { version: { gte: nextVersion } } },
          ...(automatic ? { autoUpdate: true } : {}),
        },
        data: {
          status: healthStatus,
          content: markdown,
          codeGraphHash: inputSnapshot?.fingerprint ?? codeGraphHash,
          schemaGraph: schemaGraphJson,
          warnings:
            docWarnings.length > 0
              ? (docWarnings as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
          errorMessage: null,
          generatedAt,
          // #782 — published: nothing left to resume.
          generationCheckpoint: Prisma.DbNull,
        },
      });
      if (!committed.count)
        throw new UnpublishableGenerationError(
          "superseded",
          "Generation revision superseded or deleted",
        );
      await tx.generatedDocumentVersion.create({
        data: {
          documentId: docId,
          version: nextVersion,
          revisionId,
          provenanceManifest,
          content: markdown,
          diffSummary:
            regeneration?.mode === "sections"
              ? `Affected sections regenerated: ${regeneration.sections.join(", ")}`
              : regeneration?.mode === "unchanged"
                ? "Source inventory updated; all section dependencies unchanged"
                : automatic && plan?.mode === "full"
                  ? `Conservative full regeneration: ${plan.reason}`
                  : // #857 — a resumed manual run says what it reused and why it rewrote the rest.
                    resume
                    ? `${nextVersion === 1 ? "Initial generation" : "Full regeneration"}, resumed: ${resumeSummary(resume)}`
                    : nextVersion === 1
                      ? "Initial generation"
                      : "Full regeneration",
          ...(plan ? { changedSymbols: JSON.stringify(plan.changed) } : {}),
        },
      });
      return persistGeneratedDocTask(
        tx,
        { projectId, generatedDocumentId: docId, version: nextVersion, revisionId },
        currentPolicy.actor.userId,
      );
    });
    claimed = false;
    // Published: the claim is gone, so a later beat must not read as superseded.
    stopHeartbeat?.();

    await dispatchGeneratedDocTask(publicationTaskId);

    // #239 — broadcast terminal status. A `degraded` doc still completed (it just
    // carries section warnings) so it reports `completed`, not `failed`; the
    // per-section warnings already surfaced live via `job:doc-section`.
    jobEvents.completed(
      "doc-generation",
      docId,
      projectId,
      healthStatus === "degraded" ? "Generated with warnings" : "Documentation ready",
    );
  } catch (caught) {
    // Stopped before any write below, so a late beat cannot change the outcome.
    stopHeartbeat?.();
    // #855 — a stopped run's cause is its stop, whatever error surfaced first
    // (an aborted model call's AbortError, say).
    const err = control?.stopError() ?? caught;
    const reason = err instanceof UnpublishableGenerationError ? err.reason : null;
    // #52 — the only record of the raw error. Logged as strings: the logger's
    // redaction pass copies own enumerable properties, and an Error's
    // `message` and `stack` are not, so `{ err }` logged `err: {}`.
    log.error("Document generation failed", {
      docId,
      projectId,
      ...(reason ? { stopped: reason } : {}),
      error: caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught),
      stack: caught instanceof Error ? caught.stack : undefined,
    });
    // #855 — a cancel asked for on this row: by this process (the run's own
    // stop reason), or by another replica or just before the commit (the row).
    let cancelRequested = reason === "aborted" && !automatic;
    if (claimed && !cancelRequested) {
      const row = await prisma.generatedDocument
        .findFirst({
          where: { id: docId, projectId, deletedAt: null, codeGraphHash: claim },
          select: { status: true },
        })
        .catch(() => null);
      cancelRequested = row?.status === "cancelling";
    }
    // #782 — the cause, on the document: stage, section and error class.
    const cause = generationFailureWarning({
      stage,
      section: stageSection,
      err: cancelRequested ? new UnpublishableGenerationError("aborted", "Cancelled") : err,
    });
    // #782 / #857 — keep what the run finished, as an unpublished `degraded`
    // draft, rather than discarding it — including when the commit fence
    // refused it (its inputs changed) or the commit itself failed: what was
    // written stays readable, its warning says it was not published, and the
    // checkpoint lets a regenerate reuse every section whose inputs still
    // match. Never when:
    // - the row is no longer this run's (`superseded`: deleted or replaced);
    // - a published version would be overwritten by a partial one (that version
    //   stays; a regenerate resumes from the checkpoint);
    // - it is an automatic regeneration (its published version stays).
    // - its inputs changed (`inputs-changed`, mid-run or at the commit fence,
    //   #867): what it wrote describes sources that no longer hold, and a
    //   `degraded` row's content is exportable. It fails instead; the
    //   checkpoint still lets a regenerate reuse every section that matches.
    // A commit refused because a cancel landed inside it reads as `superseded`,
    // but the row is still this run's: it is a cancel, and keeps its work.
    const salvage =
      claimed &&
      !automatic &&
      !hadVersion &&
      (cancelRequested || (reason !== "superseded" && reason !== "inputs-changed"))
        ? (synthesized ??
          (finishedSections.length > 0
            ? {
                markdown: partialDocumentMarkdown(title, finishedSections),
                warnings: finishedSections.flatMap((record) => record.warnings),
              }
            : undefined))
        : undefined;
    if (cancelRequested && claimed) {
      // #855 — a clear `cancelled` state that keeps what was finished, and the
      // checkpoint (untouched here) for a regenerate to resume from.
      // #867 — except a run over a published version, manual or automatic: that
      // version is still what the document shows, so the row goes back to the
      // state it had, and stays exportable. A manual regenerate read its row as
      // `pending` (the route's reset), so that version's settled state is `ready`.
      const restore = hadVersion
        ? (restoreOnCancel ?? {
            status: "ready",
            errorMessage: null,
            warnings: Prisma.DbNull,
          })
        : undefined;
      const cancelled = await prisma.generatedDocument.updateMany({
        where: { id: docId, projectId, deletedAt: null, codeGraphHash: claim },
        data: restore
          ? { ...restore, codeGraphHash: originalHash }
          : {
              status: "cancelled",
              codeGraphHash: originalHash,
              errorMessage: GENERATION_CANCELLED_MESSAGE,
              warnings: [...(salvage?.warnings ?? []), cause] as unknown as Prisma.InputJsonValue,
              ...(salvage ? { content: salvage.markdown, generatedAt: new Date() } : {}),
            },
      });
      if (cancelled.count) {
        log.info("Document generation cancelled", {
          docId,
          projectId,
          stage,
          sections: finishedSections.length,
          ...(control ? { spend: control.spend() } : {}),
        });
        jobEvents.completed("doc-generation", docId, projectId, "Generation cancelled");
      }
      // #867 — the scheduler records the task as cancelled: not a success, and
      // not a failure it would retry (which would undo the cancel).
      if (automatic) throw new TaskAbortError("user", "Generation cancelled by user");
      return;
    }
    const salvaged = salvage
      ? await prisma.generatedDocument.updateMany({
          where: { id: docId, projectId, deletedAt: null, codeGraphHash: claim },
          data: {
            status: "degraded",
            content: salvage.markdown,
            codeGraphHash: originalHash,
            warnings: [...salvage.warnings, cause] as unknown as Prisma.InputJsonValue,
            errorMessage: null,
            generatedAt: new Date(),
          },
        })
      : null;
    if (salvaged?.count) {
      log.warn("Document generation stopped early; finished sections kept", {
        docId,
        projectId,
        stage,
        ...(reason ? { stopped: reason } : {}),
        sections: finishedSections.length,
        assembled: synthesized != null,
      });
      jobEvents.completed(
        "doc-generation",
        docId,
        projectId,
        reason === "budget"
          ? "Generation reached its cost ceiling; the finished sections were saved"
          : "Generation stopped early; the finished sections were saved",
      );
      return;
    }
    const failed = claimed
      ? await prisma.generatedDocument.updateMany({
          where: { id: docId, projectId, deletedAt: null, codeGraphHash: claim },
          // #52 — a fixed, user-safe reason; the raw error is in the log above.
          // #782 — and the cause, structured, where the UI can show it.
          data: {
            status: "failed",
            codeGraphHash: originalHash,
            errorMessage: generationFailureMessage(err),
            warnings: [cause] as unknown as Prisma.InputJsonValue,
          },
        })
      : pendingUpdatedAt
        ? await prisma.generatedDocument.updateMany({
            // A manual request can fail before acquiring its generation claim. Only
            // terminate the pending row we read, never a concurrent request's work.
            where: {
              id: docId,
              projectId,
              deletedAt: null,
              status: "pending",
              updatedAt: pendingUpdatedAt,
              codeGraphHash: originalHash,
            },
            data: { status: "failed", errorMessage: genericFailureMessage("doc-generation") },
          })
        : null;
    // #239 — broadcast the failure so the UI leaves the "generating" state.
    // #254 — send a generic, user-safe message over the socket; full error
    // detail is retained in the server log above (log.error), never the client.
    if (failed?.count)
      jobEvents.failed("doc-generation", docId, projectId, genericFailureMessage("doc-generation"));
    if (automatic) throw err;
  } finally {
    stopHeartbeat?.();
    if (control) releaseGenerationControl(control);
  }
}
