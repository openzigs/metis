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
 *   GET    /:docId/versions/:versionId/changed-symbols — its changed symbols, paged (#190)
 *   GET    /:docId/export        — export as PDF or Word
 *   GET    /:docId/schema-graph  — structured schema graph (Epic #895)
 *   PATCH  /:docId               — update metadata (title, autoUpdate)
 *   DELETE /:docId               — soft-delete a document
 */
import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { RequestHandler } from "express";
import * as authMiddleware from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
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
  normalizeGeneratedDocVersionRecord,
} from "../lib/docs-gen/generated-doc-provenance.js";
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
  GENERATION_INTERRUPTED_MESSAGE,
  startGenerationHeartbeat,
} from "../lib/docs-gen/interrupted-generations.js";
import {
  generationFailureMessage,
  publicDocWarnings,
  publicGenerationErrorMessage,
} from "../lib/docs-gen/generation-failure-message.js";
import { publicIndexingErrorMessage } from "../lib/rag/indexing-failure-message.js";

const log = createChildLogger("generated-docs");

type IndexingVersion = {
  version: number;
  revisionId: string | null;
  provenanceManifest: string | null;
};
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

function canUseLegacyIndex(version: IndexingVersion | undefined, outbox?: PublicationState) {
  if (outbox) return false;
  // Pre-publication versions can have a backfilled revision ID. A real current
  // manifest (or an unreadable one) is not evidence of a legacy publication.
  if (!version?.provenanceManifest) return true;
  try {
    return (
      parseGeneratedDocVersionManifest(version.provenanceManifest).legacy.historicalCitations ===
      "legacy-unknown"
    );
  } catch {
    return false;
  }
}

function unpublishedIndex(outbox?: PublicationState | null) {
  const failed = outbox?.status === "failed" || outbox?.status === "cancelled";
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
    scopeFilter: z.record(z.unknown()).optional().default({}),
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
 * #190 — the revision id the detail payload has always reported, without
 * loading the (potentially multi-megabyte) manifest for rows that store it.
 */
async function versionRevisionId(
  projectId: string,
  generatedDocumentId: string,
  version: { id: string; version: number; revisionId: string | null },
): Promise<string> {
  if (version.revisionId) return version.revisionId;
  return normalizeGeneratedDocVersionRecord(
    {
      documentId: generatedDocumentId,
      version: version.version,
      revisionId: null as string | null,
      provenanceManifest: await storedManifest(generatedDocumentId, version.id),
    },
    { projectId, generatedDocumentId },
  ).revisionId;
}

const refreshAuthenticatedUser: RequestHandler =
  authMiddleware.refreshAuthenticatedUser ?? ((_req, _res, next) => next());

export function generatedDocsRouter(): Router {
  const r = Router({ mergeParams: true });
  r.use(authMiddleware.requireAuth);
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
          select: { version: true, revisionId: true, provenanceManifest: true },
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
      syntheticDocuments.map((document) => [
        document.id,
        {
          state: document.indexState,
          status: document.status,
          chunkCount: document.chunkCount,
          // #98 — never the ingest pipeline's raw exception text.
          errorMessage: publicIndexingErrorMessage(document.errorMessage, document.indexState),
          processedAt: document.processedAt,
        },
      ]),
    );
    res.json({
      data: docs.map((doc) => {
        const outbox = outboxes.get(publicationId(projectId, doc.id, doc.versions?.[0]) ?? "");
        return {
          ...doc,
          versions: doc.versions?.map(({ revisionId }) => ({ revisionId })),
          indexing:
            indexByGeneratedDocId.get(identityByDocument.get(doc.id)!) ??
            (canUseLegacyIndex(doc.versions?.[0], outbox)
              ? indexByGeneratedDocId.get(generatedDocSyntheticDocumentId(doc.id))
              : undefined) ??
            unpublishedIndex(outbox),
        };
      }),
    });
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
    const outboxId = publicationId(
      projectId,
      doc.id,
      latest && { ...latest, provenanceManifest: null },
    );
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
      canUseLegacyIndex(
        { ...latest, provenanceManifest: await storedManifest(docId, latest.id) },
        outbox ?? undefined,
      )
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
        indexing: syntheticDocument
          ? {
              state: syntheticDocument.indexState,
              status: syntheticDocument.status,
              chunkCount: syntheticDocument.chunkCount,
              // #98 — same rule as the list handler.
              errorMessage: publicIndexingErrorMessage(
                syntheticDocument.errorMessage,
                syntheticDocument.indexState,
              ),
              processedAt: syntheticDocument.processedAt,
            }
          : unpublishedIndex(outbox),
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

  // GET /:docId/versions/:versionId/changed-symbols?offset=&limit= — a page of
  // the symbols the version regenerated, with the total.
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
      const { version } = await findVersion(req, { changedSymbols: true });
      let symbols: unknown;
      try {
        symbols = JSON.parse(version.changedSymbols);
      } catch {
        symbols = null;
      }
      if (!Array.isArray(symbols)) {
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
    res.json({
      data: {
        ...updated,
        errorMessage: publicGenerationErrorMessage(updated.status, updated.errorMessage),
        // #67 — see the GET handler: the row's warnings column is the degraded
        // path's equivalent of `errorMessage` and gets the same treatment.
        warnings: publicDocWarnings(updated.warnings),
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
      const reset = await prisma.generatedDocument.updateMany({
        where: { id: docId, projectId, deletedAt: null, status: "failed" },
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
          `Only a failed document can be regenerated (status: ${existing.status})`,
        );
      }
      void generateDocumentAsync(docId, projectId).catch((err) => {
        log.error("Background doc regeneration failed", { err, docId });
      });
      res.status(202).json({ data: { id: docId, status: "pending" } });
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
    for (const id of tasks) await dispatchGeneratedDocTask(id);
    res.status(204).send();
  });

  return r;
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
  let pendingUpdatedAt: Date | undefined;
  // #50 — refreshes the row while this run holds its claim; a stopped heartbeat
  // is how the interrupted-generation sweep tells a dead run from a live one.
  let stopHeartbeat: (() => void) | undefined;
  try {
    if (automatic?.signal.aborted) throw new Error("Regeneration aborted");
    const original = await prisma.generatedDocument.findFirst({
      where: { id: docId, projectId, deletedAt: null },
    });
    if (!original || (automatic && !original.autoUpdate)) return;
    originalHash = original.codeGraphHash;
    if (!automatic && original.status === "pending") pendingUpdatedAt = original.updatedAt;
    const policy = await resolveEvidencePolicy(original);
    const lastVersion = await prisma.generatedDocumentVersion.findFirst({
      where: { documentId: docId },
      orderBy: { version: "desc" },
    });
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
        OR: [
          { status: { not: "generating" } },
          { updatedAt: { lt: new Date(Date.now() - 7_200_000) } },
        ],
        ...(automatic ? { autoUpdate: true } : {}),
      },
      data: { status: "generating", codeGraphHash: claim },
    });
    if (!acquired.count) throw new Error("Generation already running or revision changed");
    claimed = true;
    stopHeartbeat = startGenerationHeartbeat(docId, projectId, claim);
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
      | "holistic"
      | "incremental-discovery"
      | "discovery-agent"
      | "database-schema"
      | undefined;
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
      const result = await synthesizeDbSchemaDocument(
        projectId,
        dbConnectorId,
        actorId,
        doc.title ?? "Database Schema",
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
      const result = await synthesizeHolisticDocument(
        projectId,
        docType,
        doc?.title ?? "Generated Documentation",
        {
          ...(automatic ? { previousManifest } : {}),
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
            jobEvents.progress(
              "doc-generation",
              docId,
              projectId,
              docPercent(phase1ProgressPercent(done, total)),
              phase1ProgressMessage(done, total),
            );
          },
        },
      );
      markdown = result.markdown;
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
    // Revalidate both authorization and inputs at the commit boundary. A deleted,
    // superseded or concurrently changed job must never publish old content.
    const current = await prisma.generatedDocument.findFirst({
      where: { id: docId, projectId, deletedAt: null },
    });
    if (!current || current.codeGraphHash !== claim) return;
    const currentPolicy = await resolveEvidencePolicy(current);
    if (automatic?.signal.aborted) throw new Error("Regeneration aborted");
    if (
      inputSnapshot &&
      (await captureGenerationInputs(current, currentPolicy)).fingerprint !==
        inputSnapshot.fingerprint
    ) {
      throw new Error(
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
        },
      });
      if (!committed.count) throw new Error("Generation revision superseded or deleted");
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
  } catch (err) {
    // #52 — the only record of the raw error. Logged as strings: the logger's
    // redaction pass copies own enumerable properties, and an Error's
    // `message` and `stack` are not, so `{ err }` logged `err: {}`.
    log.error("Document generation failed", {
      docId,
      projectId,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    const failed = claimed
      ? await prisma.generatedDocument.updateMany({
          where: { id: docId, projectId, deletedAt: null, codeGraphHash: claim },
          // #52 — a fixed, user-safe reason; the raw error is in the log above.
          data: {
            status: "failed",
            codeGraphHash: originalHash,
            errorMessage: generationFailureMessage(err),
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
  }
}
