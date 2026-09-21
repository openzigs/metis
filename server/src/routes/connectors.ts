/**
 * /api/projects/:projectId/connectors — Phase 8 routes (issues #59–#64).
 *
 * Repo connector:
 *   GET    /repos                       list
 *   POST   /repos                       create   (connector.write)
 *   GET    /repos/:id                   detail
 *   PATCH  /repos/:id                   update   (connector.write)
 *   DELETE /repos/:id                   delete   (connector.write)
 *   POST   /repos/:id/test              test     (connector.test)
 *   POST   /repos/:id/metadata          fetch metadata (connector.read)
 *   POST   /repos/:id/ingest            ingest into RAG (connector.write)
 *
 * Database connector:
 *   GET    /dbs                         list
 *   POST   /dbs                         create   (connector.write)
 *   GET    /dbs/:id                     detail
 *   PATCH  /dbs/:id                     update   (connector.write)
 *   DELETE /dbs/:id                     delete   (connector.write)
 *   POST   /dbs/:id/test                test     (connector.test)
 *   POST   /dbs/:id/inspect             schema introspection (connector.read)
 *   POST   /dbs/:id/query               SELECT-only query   (connector.query)
 *   POST   /dbs/:id/ingest              ingest schema into RAG (connector.write)
 */
import { Router, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import {
  type ApiResponse,
  createDatabaseConnectorSchema,
  createRepoConnectorSchema,
  updateDatabaseConnectorSchema,
  updateRepoConnectorSchema,
  MAX_UPLOAD_ARCHIVE_BYTES,
  REPO_PROVIDER_LOCAL,
  REPO_PROVIDER_UPLOAD,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import {
  connectorMetadataRateLimiter,
  connectorQueryRateLimiter,
  connectorTestRateLimiter,
} from "../middleware/connector-rate-limit.js";
import { AppError } from "../middleware/error-handler.js";
import { ConnectorError } from "../lib/connectors/types.js";
import { isDriverDetailCode, sanitizeDriverError } from "../lib/connectors/driver-error.js";
import {
  createDbConnector,
  buildCodeGraphSchemaWiring,
  deleteDbConnector,
  getDbConnector,
  inspectDbConnector,
  listDbConnectors,
  queryDbConnector,
  testDbConnector,
  updateDbConnector,
} from "../lib/connectors/db/db-service.js";
import {
  linkConnectionToResourceExplicit,
  reresolveConnectionResource,
  resolveProjectDatabaseIdentities,
  unlinkConnectionFromResource,
} from "../lib/cross-project/analysis-database-identity.js";
import {
  createRepoConnector,
  createUploadRepoConnector,
  deleteRepoConnector,
  fetchRepoMetadata,
  getPrimaryRepo,
  getRepoConnector,
  getRepoConnectorEmitter,
  listRepoConnectors,
  pullOrCloneRepo,
  resolveNonGitIngestRoot,
  setPrimaryRepo,
  shallowCloneRepo,
  testRepoConnector,
  updateRepoConnector,
} from "../lib/connectors/repo/repo-service.js";
import {
  ingestDbSchema,
  ingestRepoMetadata,
  ingestSourceAsKnowledge,
} from "../lib/connectors/connector-ingest.js";
import { ingestCodeGraph } from "../lib/code-graph/ingest.js";
import { checkIncrementalRegeneration } from "../lib/docs-gen/incremental.js";
import { discoverAndUpsertConnections } from "../lib/connectors/repo/connection-discovery.js";
import { prisma } from "../lib/prisma.js";
import { createChildLogger } from "../lib/logger.js";
import {
  ingestConfluenceSpace,
  ingestJiraQuery,
  resolveAtlassianMCPServer,
} from "../lib/connectors/atlassian.js";

const logger = createChildLogger("connector-ingest");

/**
 * Issue #288 — multer instance for .zip folder uploads. In-memory storage with
 * a hard single-file + size cap; the buffer is handed to the extractor which
 * enforces zip-slip / zip-bomb guards. We never persist the raw multipart body
 * to disk before validation.
 */
const uploadArchive = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_ARCHIVE_BYTES, files: 1 },
});

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

/**
 * Epic #820 (#821) — body for POST /dbs/:id/link. Only a resource id; the
 * connection + target workspace are derived server-side so the caller cannot
 * cross a tenant boundary. Bounded length to reject oversized/garbage input.
 */
const linkDatabaseResourceSchema = z.object({
  databaseResourceId: z.string().trim().min(1).max(191),
});

function actor(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

/**
 * Issue #1084 — a `ConnectorError` raised by a driver or by the host
 * allow-list carries the resolved address, port, database name and sometimes
 * credential fragments in its message. The caller supplied the host, so
 * echoing that back is reconnaissance. Rewrite the message; keep the code and
 * status (they are bare machine identifiers, and the allow-list hint is what
 * an operator needs to fix a legitimate misconfiguration). The raw string is
 * logged server-side.
 */
function safeConnectorMessage(err: ConnectorError): string {
  if (!isDriverDetailCode(err.code)) return err.message;
  logger.warn("connector driver error sanitized for the client", {
    code: err.code,
    status: err.status,
    rawError: err.message,
  });
  return sanitizeDriverError(err.code, err.message).errorMessage;
}

function rethrow(err: unknown): never {
  if (err instanceof ConnectorError) {
    throw new AppError(err.status, err.code, safeConnectorMessage(err));
  }
  throw err;
}

function projectIdOf(req: Request): string {
  const id = String(req.params.projectId ?? "");
  if (!id) throw new AppError(400, "PROJECT_REQUIRED", "projectId path parameter is required");
  return id;
}

/**
 * Extracted deep-ingest pipeline for reuse by the auto-ingest trigger (#667).
 * Performs: shallow clone → code-graph → RAG ingest → metadata → discovery.
 */

/** In-memory concurrency guard: connectors currently being ingested (#663 review). */
const activeIngests = new Set<string>();

/**
 * Issue #288 — resolve the directory an ingest should walk, branching on
 * provider. GitHub clones (behaviour unchanged); `local`/`upload` skip the
 * clone and return the validated server path / freshly-extracted archive. The
 * `boundary` (set only for `local`) confines the source walk to the validated
 * directory so symlinks can't escape it.
 */
async function resolveIngestSource(
  projectId: string,
  connectorId: string,
  userId: string,
): Promise<{ path: string; sizeBytes: number; boundary?: string; isGit: boolean }> {
  const conn = await getRepoConnector(projectId, connectorId);
  if (conn.provider === REPO_PROVIDER_LOCAL || conn.provider === REPO_PROVIDER_UPLOAD) {
    const root = await resolveNonGitIngestRoot(projectId, connectorId);
    return { path: root.path, sizeBytes: 0, boundary: root.boundary, isGit: false };
  }
  const clone = await shallowCloneRepo(projectId, connectorId, userId);
  return { path: clone.path, sizeBytes: clone.sizeBytes, isGit: true };
}

async function triggerDeepIngest(projectId: string, connectorId: string, userId: string) {
  // Concurrency guard — prevent duplicate parallel ingests on the same connector
  if (activeIngests.has(connectorId)) {
    return;
  }
  activeIngests.add(connectorId);

  const emitter = getRepoConnectorEmitter();
  const emitProgress = (step: string, current: number) =>
    emitter.progress({
      connectorId,
      projectId,
      kind: "repo",
      phase: "deep-ingest",
      step,
      current,
      total: 5,
    });

  try {
    emitProgress("Resolving source", 1);
    // Issue #288 — github clones; local/upload resolve a server path / archive.
    const source = await resolveIngestSource(projectId, connectorId, userId);
    emitProgress("Building code graph", 2);
    // Best-effort SQL-lineage wiring from the project's DB connector (#316/#317);
    // never blocks ingest when no DB connector is configured.
    const deepSchemaWiring = await buildCodeGraphSchemaWiring(projectId, userId);
    await ingestCodeGraph(prisma, {
      projectId,
      rootDir: source.path,
      repoConnectionId: connectorId,
      triggeredByUserId: userId,
      introspectedSchema: deepSchemaWiring.introspectedSchema,
      routines: deepSchemaWiring.routines,
      fetchRoutineBody: deepSchemaWiring.fetchRoutineBody,
      routineDialect: deepSchemaWiring.routineDialect,
      packages: deepSchemaWiring.packages,
      fetchPackageBody: deepSchemaWiring.fetchPackageBody,
      dependencies: deepSchemaWiring.dependencies,
      sqlLineageOverride: deepSchemaWiring.sqlLineageOverride,
      // #797 — background-embed the symbols so `search_code_symbols` gets its
      // vector half. Fire-and-forget; never blocks this request.
      embedSymbols: true,
    });
    emitProgress("Ingesting source code", 3);
    const srcSummary = await ingestSourceAsKnowledge(projectId, connectorId, userId, source.path, {
      boundary: source.boundary,
    });
    let metadataSucceeded = true;
    emitProgress("Indexing metadata", 4);
    if (source.isGit) {
      try {
        const meta = await fetchRepoMetadata(projectId, connectorId, userId);
        const summary = await ingestRepoMetadata(projectId, connectorId, userId, meta);
        metadataSucceeded = summary.failures === 0;
      } catch (metaErr) {
        metadataSucceeded = false;
        // Metadata is supplementary — a misconfigured apiBaseUrl (e.g. missing
        // /api/v3 suffix on GHE) or missing token should not block the ingest.
        logger.warn("fetchRepoMetadata failed — skipping metadata ingest, core ingest continues", {
          err: metaErr,
          projectId,
          connectorId,
        });
      }
    }
    emitProgress("Discovering connections", 5);
    const discovery = await discoverAndUpsertConnections(projectId, source.path);
    if (srcSummary.failures === 0 && metadataSucceeded)
      await checkIncrementalRegeneration(projectId, connectorId);
    if (discovery.connectionsFound > 0) {
      const connector = await getRepoConnector(projectId, connectorId);
      emitter.discovery({
        projectId,
        connectorId,
        repoLabel: connector.label,
        connectionsFound: discovery.connectionsFound,
      });
    }
  } catch (err) {
    // Emit error progress so the UI can show failure and dismiss the progress bar
    emitter.progress({
      connectorId,
      projectId,
      kind: "repo",
      phase: "deep-ingest",
      step: (err as Error).message || "Ingestion failed",
      status: "error",
      errorMessage: (err as Error).message || "Unknown error",
    });
    throw err;
  } finally {
    activeIngests.delete(connectorId);
  }
}

export function connectorsRouter(): Router {
  const r = Router({ mergeParams: true });

  // Epic #671 / #674 — object-level project scope (OWASP A01 / BOLA). Every
  // route in this router is addressed under `/projects/:projectId/connectors`;
  // resolving a repo/db connector leaks another tenant's repo identity +
  // `secretRef` credential config, so gate the whole subtree on the caller's
  // membership of the target project's workspace BEFORE any handler runs.
  // Non-members get a 404 (no existence oracle); admins bypass.
  r.use(requireAuth, requireProjectAccess());

  // ── Repo ─────────────────────────────────────────────────────────────────
  r.get("/repos", requireAuth, requirePermission("connector.read"), async (req, res) => {
    try {
      res.json(ok(await listRepoConnectors(projectIdOf(req))));
    } catch (err) {
      rethrow(err);
    }
  });
  r.post("/repos", requireAuth, requirePermission("connector.write"), async (req, res) => {
    const parsed = createRepoConnectorSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
        issues: parsed.error.flatten(),
      });
    }
    // Issue #288 — `local` requires admin authZ (use POST /repos/local) and
    // `upload` requires a multipart body (use POST /repos/upload). Reject them
    // on this JSON/connector.write route so neither bypasses its stricter path.
    if (parsed.data.provider === REPO_PROVIDER_LOCAL) {
      throw new AppError(
        400,
        "USE_LOCAL_ENDPOINT",
        "Create local connectors via POST /repos/local (requires admin)",
      );
    }
    if (parsed.data.provider === REPO_PROVIDER_UPLOAD) {
      throw new AppError(
        400,
        "USE_UPLOAD_ENDPOINT",
        "Create upload connectors via POST /repos/upload (multipart .zip)",
      );
    }
    try {
      const projectId = projectIdOf(req);
      const a = actor(req);
      const { autoIngest, ...connectorData } = parsed.data;
      const created = await createRepoConnector(projectId, connectorData, a);

      // Auto-ingest: if explicitly requested OR this is the first repo connector
      const existingRepos = await listRepoConnectors(projectId);
      const isFirstRepo = existingRepos.length === 1;
      const shouldAutoIngest = autoIngest === true || isFirstRepo;

      if (shouldAutoIngest) {
        // Trigger deep-ingest in the background — don't block the creation response
        void triggerDeepIngest(projectId, created.id, a).catch(() => {
          /* logged internally */
        });
      }

      res.status(201).json(ok({ ...created, autoIngestTriggered: shouldAutoIngest }));
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Issue #288: local server-path connector (ADMIN-only) ─────────────────
  // Reading arbitrary server files is privileged, so this is gated on
  // `admin.write` (only the `admin` role) on TOP of the LOCAL_SOURCE_ROOTS
  // allowlist + realpath containment enforced in the service layer.
  r.post("/repos/local", requireAuth, requirePermission("admin.write"), async (req, res) => {
    const parsed = createRepoConnectorSchema.safeParse({
      ...(req.body ?? {}),
      provider: REPO_PROVIDER_LOCAL,
    });
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
        issues: parsed.error.flatten(),
      });
    }
    try {
      const projectId = projectIdOf(req);
      const a = actor(req);
      const { autoIngest, ...connectorData } = parsed.data;
      const created = await createRepoConnector(projectId, connectorData, a);
      const existingRepos = await listRepoConnectors(projectId);
      const shouldAutoIngest = autoIngest === true || existingRepos.length === 1;
      if (shouldAutoIngest) {
        void triggerDeepIngest(projectId, created.id, a).catch(() => {
          /* logged internally */
        });
      }
      res.status(201).json(ok({ ...created, autoIngestTriggered: shouldAutoIngest }));
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Issue #288: folder upload (.zip) connector (project WRITE) ───────────
  // multer enforces single-file + the archive size cap; we additionally check
  // the extension/mimetype before the body is parsed. The service layer runs
  // the zip-slip / zip-bomb guards during extraction.
  r.post(
    "/repos/upload",
    requireAuth,
    requirePermission("connector.write"),
    uploadArchive.single("file"),
    async (req, res) => {
      try {
        const projectId = projectIdOf(req);
        const a = actor(req);
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) {
          throw new AppError(400, "FILE_REQUIRED", "a .zip file is required");
        }
        const label = String((req.body as { label?: unknown })?.label ?? "").trim();
        if (!label) {
          throw new AppError(400, "LABEL_REQUIRED", "label is required");
        }
        const lower = file.originalname.toLowerCase();
        const okMime =
          file.mimetype === "application/zip" ||
          file.mimetype === "application/x-zip-compressed" ||
          file.mimetype === "application/octet-stream";
        if (!lower.endsWith(".zip") || !okMime) {
          throw new AppError(400, "INVALID_ARCHIVE", "only .zip uploads are accepted");
        }
        const created = await createUploadRepoConnector(projectId, label, file.buffer, a);
        const existingRepos = await listRepoConnectors(projectId);
        const shouldAutoIngest = existingRepos.length === 1;
        if (shouldAutoIngest) {
          void triggerDeepIngest(projectId, created.id, a).catch(() => {
            /* logged internally */
          });
        }
        res.status(201).json(ok({ ...created, autoIngestTriggered: shouldAutoIngest }));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ── Get primary repo (must be before /repos/:id) ──────────────────────
  r.get("/repos/primary", requireAuth, requirePermission("connector.read"), async (req, res) => {
    const primary = await getPrimaryRepo(projectIdOf(req));
    res.json(ok(primary));
  });

  r.get("/repos/:id", requireAuth, requirePermission("connector.read"), async (req, res) => {
    try {
      res.json(ok(await getRepoConnector(projectIdOf(req), String(req.params.id))));
    } catch (err) {
      rethrow(err);
    }
  });
  r.patch("/repos/:id", requireAuth, requirePermission("connector.write"), async (req, res) => {
    const parsed = updateRepoConnectorSchema.safeParse({
      ...(req.body ?? {}),
      id: String(req.params.id),
    });
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
        issues: parsed.error.flatten(),
      });
    }
    const { id: _id, ...patch } = parsed.data;
    try {
      const updated = await updateRepoConnector(
        projectIdOf(req),
        String(req.params.id),
        patch,
        actor(req),
      );
      res.json(ok(updated));
    } catch (err) {
      rethrow(err);
    }
  });
  r.delete("/repos/:id", requireAuth, requirePermission("connector.write"), async (req, res) => {
    try {
      await deleteRepoConnector(projectIdOf(req), String(req.params.id), actor(req));
      res.status(204).end();
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Set primary ────────────────────────────────────────────────────────
  r.patch(
    "/repos/:id/set-primary",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      try {
        const updated = await setPrimaryRepo(projectIdOf(req), String(req.params.id), actor(req));
        res.json(ok(updated));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.post(
    "/repos/:id/test",
    requireAuth,
    connectorTestRateLimiter,
    requirePermission("connector.test"),
    async (req, res) => {
      try {
        const result = await testRepoConnector(projectIdOf(req), String(req.params.id), actor(req));
        res.json(ok(result));
      } catch (err) {
        // A ConnectorError (e.g. 401 auth failure, 404 not found) is a
        // connectivity result — NOT a session/server error. Return 200 with
        // ok:false so the frontend can display it without triggering the
        // 401 → logout redirect.
        if (err instanceof ConnectorError) {
          res.json(ok({ ok: false, message: safeConnectorMessage(err), code: err.code }));
          return;
        }
        rethrow(err);
      }
    },
  );
  r.post(
    "/repos/:id/metadata",
    requireAuth,
    connectorMetadataRateLimiter,
    requirePermission("connector.read"),
    async (req, res) => {
      try {
        const meta = await fetchRepoMetadata(projectIdOf(req), String(req.params.id), actor(req));
        res.json(ok(meta));
      } catch (err) {
        rethrow(err);
      }
    },
  );
  r.post(
    "/repos/:id/ingest",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      try {
        const projectId = projectIdOf(req);
        const id = String(req.params.id);
        const a = actor(req);
        const meta = await fetchRepoMetadata(projectId, id, a);
        const summary = await ingestRepoMetadata(projectId, id, a, meta);
        res.json(ok(summary));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // POST /repos/:id/deep-ingest — clone + code-graph + RAG ingest
  // Clones the repo, parses all source files into a code graph (symbols,
  // edges, rationale), then ingests file content into the RAG knowledge base
  // so the analysis pipeline can reason about the actual source code.
  r.post(
    "/repos/:id/deep-ingest",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      try {
        const projectId = projectIdOf(req);
        const id = String(req.params.id);
        // Concurrency guard
        if (activeIngests.has(id)) {
          throw new AppError(
            409,
            "INGEST_IN_PROGRESS",
            "Deep-ingest is already running for this connector",
          );
        }
        const a = actor(req);
        const emitter = getRepoConnectorEmitter();
        const emitProgress = (step: string, current: number) =>
          emitter.progress({
            connectorId: id,
            projectId,
            kind: "repo",
            phase: "deep-ingest",
            step,
            current,
            total: 5,
          });
        activeIngests.add(id);
        try {
          // Step 1: resolve source (github clones; local/upload skip the clone)
          emitProgress("Resolving source", 1);
          const source = await resolveIngestSource(projectId, id, a);
          // Step 2: code graph ingest (symbols, edges, rationale). Best-effort
          // SQL-lineage wiring from the project's DB connector (#316/#317): feeds
          // the live schema (SELECT* expansion) + routine bodies (`calls` edges).
          // Never blocks ingest if no DB connector / introspection fails.
          emitProgress("Building code graph", 2);
          const schemaWiring = await buildCodeGraphSchemaWiring(projectId, a);
          const stats = await ingestCodeGraph(prisma, {
            projectId,
            rootDir: source.path,
            repoConnectionId: id,
            triggeredByUserId: a,
            introspectedSchema: schemaWiring.introspectedSchema,
            routines: schemaWiring.routines,
            fetchRoutineBody: schemaWiring.fetchRoutineBody,
            routineDialect: schemaWiring.routineDialect,
            packages: schemaWiring.packages,
            fetchPackageBody: schemaWiring.fetchPackageBody,
            dependencies: schemaWiring.dependencies,
            sqlLineageOverride: schemaWiring.sqlLineageOverride,
            embedSymbols: true, // #797
          });
          // Step 3: ingest source files into RAG knowledge base
          emitProgress("Ingesting source code", 3);
          const srcSummary = await ingestSourceAsKnowledge(projectId, id, a, source.path, {
            boundary: source.boundary,
          });
          // Step 4: also run metadata ingest for RAG chunks (github only)
          emitProgress("Indexing metadata", 4);
          let metadataSucceeded = true;
          if (source.isGit) {
            try {
              const meta = await fetchRepoMetadata(projectId, id, a);
              const summary = await ingestRepoMetadata(projectId, id, a, meta);
              metadataSucceeded = summary.failures === 0;
            } catch (metaErr) {
              metadataSucceeded = false;
              logger.warn(
                "fetchRepoMetadata failed — skipping metadata ingest, core ingest continues",
                { err: metaErr, projectId, connectorId: id },
              );
            }
          }
          // Step 5: scan for database connection references (epic #467)
          emitProgress("Discovering connections", 5);
          const discovery = await discoverAndUpsertConnections(projectId, source.path);
          if (srcSummary.failures === 0 && metadataSucceeded)
            await checkIncrementalRegeneration(projectId, id);
          // Step 6: emit discovery notification via Socket.IO (#669)
          if (discovery.connectionsFound > 0) {
            const connector = await getRepoConnector(projectId, id);
            emitter.discovery({
              projectId,
              connectorId: id,
              repoLabel: connector.label,
              connectionsFound: discovery.connectionsFound,
            });
          }
          res.json(
            ok({
              codeGraph: {
                filesScanned: stats.filesScanned,
                filesParsed: stats.filesParsed,
                symbolsUpserted: stats.symbolsUpserted,
                edgesUpserted: stats.edgesUpserted,
                rationaleFindings: stats.rationaleFindings,
                languageStats: stats.languageStats,
                durationMs: stats.durationMs,
              },
              sourceKnowledge: {
                documentsCreated: srcSummary.documentsCreated,
                documentsUpdated: srcSummary.documentsUpdated,
                chunkCount: srcSummary.chunkCount,
                failures: srcSummary.failures,
              },
              suggestedConnectors: {
                filesScanned: discovery.filesScanned,
                connectionsFound: discovery.connectionsFound,
                suggestionsUpserted: discovery.suggestionsUpserted,
              },
              cloneSizeBytes: source.sizeBytes,
            }),
          );
        } finally {
          activeIngests.delete(id);
        }
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // POST /repos/:id/refresh-ingest — git pull (or re-clone) + incremental
  // code-graph + RAG re-ingest.  Designed for both manual "sync now" triggers
  // from the UI and scheduled refresh tasks.  Only re-parses files whose
  // content hash changed since the last run.
  r.post(
    "/repos/:id/refresh-ingest",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      try {
        const projectId = projectIdOf(req);
        const id = String(req.params.id);
        const a = actor(req);
        // Step 1: github pulls (or re-clones); local re-validates path; upload
        // re-extracts the stored archive. Both non-git providers skip the clone.
        const conn = await getRepoConnector(projectId, id);
        const isNonGit =
          conn.provider === REPO_PROVIDER_LOCAL || conn.provider === REPO_PROVIDER_UPLOAD;
        let clone: { path: string; sizeBytes: number; pulled: boolean; filesChanged: number };
        let boundary: string | undefined;
        if (isNonGit) {
          const root = await resolveNonGitIngestRoot(projectId, id);
          clone = { path: root.path, sizeBytes: 0, pulled: false, filesChanged: 0 };
          boundary = root.boundary;
        } else {
          clone = await pullOrCloneRepo(projectId, id, a);
        }
        // Step 2: incremental code-graph — only changed files are re-parsed.
        // Best-effort SQL-lineage wiring from the project's DB connector
        // (#316/#317); never blocks ingest if unavailable.
        const refreshSchemaWiring = await buildCodeGraphSchemaWiring(projectId, a);
        const stats = await ingestCodeGraph(prisma, {
          projectId,
          rootDir: clone.path,
          repoConnectionId: id,
          triggeredByUserId: a,
          introspectedSchema: refreshSchemaWiring.introspectedSchema,
          routines: refreshSchemaWiring.routines,
          fetchRoutineBody: refreshSchemaWiring.fetchRoutineBody,
          routineDialect: refreshSchemaWiring.routineDialect,
          packages: refreshSchemaWiring.packages,
          fetchPackageBody: refreshSchemaWiring.fetchPackageBody,
          dependencies: refreshSchemaWiring.dependencies,
          sqlLineageOverride: refreshSchemaWiring.sqlLineageOverride,
          embedSymbols: true, // #797 — a refresh keeps symbol vectors current
        });
        // Step 3: incremental RAG knowledge ingest
        const srcSummary = await ingestSourceAsKnowledge(projectId, id, a, clone.path, {
          boundary,
        });
        // Step 4: refresh metadata (README, head SHA, etc.) — github only
        let metadataSucceeded = true;
        if (!isNonGit) {
          try {
            const meta = await fetchRepoMetadata(projectId, id, a);
            const summary = await ingestRepoMetadata(projectId, id, a, meta);
            metadataSucceeded = summary.failures === 0;
          } catch (metaErr) {
            metadataSucceeded = false;
            logger.warn(
              "fetchRepoMetadata failed — skipping metadata ingest, core ingest continues",
              { err: metaErr, projectId, connectorId: id },
            );
          }
        }
        // Step 5: re-scan for database connection references (epic #467)
        const discovery = await discoverAndUpsertConnections(projectId, clone.path);
        if (srcSummary.failures === 0 && metadataSucceeded)
          await checkIncrementalRegeneration(projectId, id);
        // Step 6: emit discovery notification via Socket.IO (#669)
        if (discovery.connectionsFound > 0) {
          const connector = await getRepoConnector(projectId, id);
          getRepoConnectorEmitter().discovery({
            projectId,
            connectorId: id,
            repoLabel: connector.label,
            connectionsFound: discovery.connectionsFound,
          });
        }
        res.json(
          ok({
            pulled: clone.pulled,
            filesChanged: clone.filesChanged,
            codeGraph: {
              filesScanned: stats.filesScanned,
              filesParsed: stats.filesParsed,
              filesSkipped: stats.filesSkipped,
              symbolsUpserted: stats.symbolsUpserted,
              edgesUpserted: stats.edgesUpserted,
              durationMs: stats.durationMs,
            },
            sourceKnowledge: {
              documentsCreated: srcSummary.documentsCreated,
              documentsUpdated: srcSummary.documentsUpdated,
              chunkCount: srcSummary.chunkCount,
            },
            suggestedConnectors: {
              filesScanned: discovery.filesScanned,
              connectionsFound: discovery.connectionsFound,
              suggestionsUpserted: discovery.suggestionsUpserted,
            },
            cloneSizeBytes: clone.sizeBytes,
          }),
        );
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // POST /repos/:id/rescan-credentials — lightweight credential-only rescan.
  // Re-clones (or reuses cached clone) and runs ONLY the connection discovery
  // scanner with credential extraction. No code-graph, no RAG, no AI calls.
  // Designed to be called after toggling allowCredentialScan on an already-
  // ingested project.
  r.post(
    "/repos/:id/rescan-credentials",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      try {
        const projectId = projectIdOf(req);
        const id = String(req.params.id);
        const a = actor(req);
        const conn = await getRepoConnector(projectId, id);
        const isNonGit =
          conn.provider === REPO_PROVIDER_LOCAL || conn.provider === REPO_PROVIDER_UPLOAD;
        const clone = isNonGit
          ? await resolveNonGitIngestRoot(projectId, id)
          : await pullOrCloneRepo(projectId, id, a);
        const discovery = await discoverAndUpsertConnections(projectId, clone.path);
        if (discovery.connectionsFound > 0) {
          const connector = await getRepoConnector(projectId, id);
          getRepoConnectorEmitter().discovery({
            projectId,
            connectorId: id,
            repoLabel: connector.label,
            connectionsFound: discovery.connectionsFound,
          });
        }
        res.json(
          ok({
            filesScanned: discovery.filesScanned,
            connectionsFound: discovery.connectionsFound,
            suggestionsUpserted: discovery.suggestionsUpserted,
            errors: discovery.errors,
          }),
        );
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ── Database ─────────────────────────────────────────────────────────────
  r.get("/dbs", requireAuth, requirePermission("connector.read"), async (req, res) => {
    try {
      res.json(ok(await listDbConnectors(projectIdOf(req))));
    } catch (err) {
      rethrow(err);
    }
  });
  // Epic #820 (#821) — analysis-facing identity resolution: each connection's
  // linked DatabaseResource (or null), whether it is linkable, and the sibling
  // projects sharing each resource. MUST be declared BEFORE `/dbs/:id` so the
  // literal `identities` path is not captured as an `:id`.
  r.get("/dbs/identities", requireAuth, requirePermission("connector.read"), async (req, res) => {
    try {
      res.json(ok(await resolveProjectDatabaseIdentities(projectIdOf(req))));
    } catch (err) {
      rethrow(err);
    }
  });
  r.post("/dbs", requireAuth, requirePermission("connector.write"), async (req, res) => {
    const parsed = createDatabaseConnectorSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
        issues: parsed.error.flatten(),
      });
    }
    try {
      const created = await createDbConnector(projectIdOf(req), parsed.data, actor(req));
      res.status(201).json(ok(created));
    } catch (err) {
      rethrow(err);
    }
  });
  r.get("/dbs/:id", requireAuth, requirePermission("connector.read"), async (req, res) => {
    try {
      res.json(ok(await getDbConnector(projectIdOf(req), String(req.params.id))));
    } catch (err) {
      rethrow(err);
    }
  });
  r.patch("/dbs/:id", requireAuth, requirePermission("connector.write"), async (req, res) => {
    const parsed = updateDatabaseConnectorSchema.safeParse({
      ...(req.body ?? {}),
      id: String(req.params.id),
    });
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
        issues: parsed.error.flatten(),
      });
    }
    const { id: _id, ...patch } = parsed.data;
    try {
      const updated = await updateDbConnector(
        projectIdOf(req),
        String(req.params.id),
        patch,
        actor(req),
      );
      res.json(ok(updated));
    } catch (err) {
      rethrow(err);
    }
  });
  r.delete("/dbs/:id", requireAuth, requirePermission("connector.write"), async (req, res) => {
    try {
      await deleteDbConnector(projectIdOf(req), String(req.params.id), actor(req));
      res.status(204).end();
    } catch (err) {
      rethrow(err);
    }
  });
  r.post(
    "/dbs/:id/test",
    requireAuth,
    connectorTestRateLimiter,
    requirePermission("connector.test"),
    async (req, res) => {
      try {
        const result = await testDbConnector(projectIdOf(req), String(req.params.id), actor(req));
        res.json(ok(result));
      } catch (err) {
        // ConnectorError = connectivity failure, not a session/server error.
        if (err instanceof ConnectorError) {
          res.json(ok({ ok: false, message: safeConnectorMessage(err), code: err.code }));
          return;
        }
        rethrow(err);
      }
    },
  );
  r.post(
    "/dbs/:id/inspect",
    requireAuth,
    connectorMetadataRateLimiter,
    requirePermission("connector.read"),
    async (req, res) => {
      try {
        const schema = typeof req.body?.schema === "string" ? req.body.schema : undefined;
        const snapshot = await inspectDbConnector(
          projectIdOf(req),
          String(req.params.id),
          actor(req),
          { schema },
        );
        res.json(ok(snapshot));
      } catch (err) {
        rethrow(err);
      }
    },
  );
  r.post(
    "/dbs/:id/query",
    requireAuth,
    connectorQueryRateLimiter,
    requirePermission("connector.query"),
    async (req, res) => {
      const sql = typeof req.body?.sql === "string" ? req.body.sql : "";
      try {
        const result = await queryDbConnector(
          projectIdOf(req),
          String(req.params.id),
          actor(req),
          sql,
        );
        res.json(ok(result));
      } catch (err) {
        rethrow(err);
      }
    },
  );
  r.post("/dbs/:id/ingest", requireAuth, requirePermission("connector.write"), async (req, res) => {
    try {
      const projectId = projectIdOf(req);
      const id = String(req.params.id);
      const a = actor(req);
      const schema = typeof req.body?.schema === "string" ? req.body.schema : undefined;
      const snapshot = await inspectDbConnector(projectId, id, a, { schema });
      const summary = await ingestDbSchema(projectId, id, a, snapshot);
      res.json(ok(summary));
    } catch (err) {
      rethrow(err);
    }
  });

  // Epic #820 (#821) — explicit operator control over the connection ↔
  // DatabaseResource link. The connectors subtree already enforces access to the
  // connection's project (requireProjectAccess); linking is further confined to a
  // resource in that project's workspace, and every mutation is audited.
  r.post("/dbs/:id/link", requireAuth, requirePermission("connector.write"), async (req, res) => {
    const parsed = linkDatabaseResourceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
        issues: parsed.error.flatten(),
      });
    }
    try {
      const result = await linkConnectionToResourceExplicit({
        projectId: projectIdOf(req),
        connectionId: String(req.params.id),
        databaseResourceId: parsed.data.databaseResourceId,
        actorId: actor(req),
      });
      res.json(ok(result));
    } catch (err) {
      rethrow(err);
    }
  });
  r.post("/dbs/:id/unlink", requireAuth, requirePermission("connector.write"), async (req, res) => {
    try {
      const result = await unlinkConnectionFromResource({
        projectId: projectIdOf(req),
        connectionId: String(req.params.id),
        actorId: actor(req),
      });
      res.json(ok(result));
    } catch (err) {
      rethrow(err);
    }
  });
  r.post(
    "/dbs/:id/reresolve",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      try {
        const result = await reresolveConnectionResource({
          projectId: projectIdOf(req),
          connectionId: String(req.params.id),
          actorId: actor(req),
        });
        res.json(ok(result));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ── Atlassian (Epic #163, Issue #96) ─────────────────────────────────────
  r.get("/atlassian/status", requireAuth, requirePermission("connector.read"), async (req, res) => {
    try {
      const projectId = projectIdOf(req);
      const server = await resolveAtlassianMCPServer(projectId);
      res.json(ok({ configured: Boolean(server), serverId: server?.id ?? null }));
    } catch (err) {
      rethrow(err);
    }
  });
  r.post(
    "/confluence/ingest",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      try {
        const projectId = projectIdOf(req);
        const spaceKey = String(req.body?.spaceKey ?? "").trim();
        const query = typeof req.body?.query === "string" ? req.body.query.trim() : undefined;
        if (!spaceKey) {
          throw new AppError(400, "SPACE_REQUIRED", "spaceKey is required");
        }
        const summary = await ingestConfluenceSpace({
          projectId,
          spaceKey,
          query: query || undefined,
          actorId: actor(req),
        });
        res.json(ok(summary));
      } catch (err) {
        rethrow(err);
      }
    },
  );
  r.post("/jira/ingest", requireAuth, requirePermission("connector.write"), async (req, res) => {
    try {
      const projectId = projectIdOf(req);
      const jql = String(req.body?.jql ?? "").trim();
      if (!jql) {
        throw new AppError(400, "JQL_REQUIRED", "jql is required");
      }
      if (jql.length > 4096) {
        throw new AppError(400, "JQL_TOO_LONG", "jql must be ≤ 4096 chars");
      }
      const summary = await ingestJiraQuery({
        projectId,
        jql,
        actorId: actor(req),
      });
      res.json(ok(summary));
    } catch (err) {
      rethrow(err);
    }
  });

  return r;
}
