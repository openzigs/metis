/**
 * /api/projects/:projectId/test-coverage — Epic #856 issue #864.
 *
 * Exposes the import + run + read surface for project-level test-coverage gap
 * analysis. Background execution (#862) is invoked asynchronously after a run
 * is created; this module never blocks the request on AI work.
 */
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";

import {
  type ApiResponse,
  MAX_DOCUMENT_BYTES,
  CreateRunBodySchema,
  OverrideMappingBodySchema,
  AcceptSuggestionBodySchema,
} from "@metis/shared";

import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { getProject } from "../lib/projects/project-service.js";
import { audit } from "../lib/audit/audit-service.js";
import type { ImportProviderResult } from "../lib/testcoverage/providers/types.js";
import {
  detectProviderForUpload,
  resolveProvider,
} from "../lib/testcoverage/providers/registry.js";
import { ColumnMappingRequiredError } from "../lib/testcoverage/providers/types.js";
import { hashCase, hashRunInput } from "../lib/testcoverage/hash.js";
import { finaliseCase } from "../lib/testcoverage/normaliser.js";
import {
  createDefaultEnqueueRun,
  type TestCoverageEmitter,
} from "../lib/testcoverage/task-runner.js";
import type { JudgeModelCaller } from "../lib/testcoverage/judge.js";
import { readBudget, DEFAULT_BUDGET_CENTS } from "../lib/testcoverage/cost-tracker.js";
import { buildCoverageReport } from "../lib/testcoverage/report-builder.js";
import {
  exportCoverageReportToExcel,
  exportSuggestionsToGherkin,
  exportSuggestionsToPlaywrightPom,
  exportSuggestionsToGithub,
  exportSuggestionsToXray,
  exportSuggestionsToZephyr,
  exportSuggestionsToTestRail,
  importJiraTestCases,
  importXrayTests,
  importZephyrCases,
  importTestRailCases,
  parseJUnitXml,
  JunitParseError,
  applyJunitResults,
} from "../lib/testcoverage/index.js";
import type { ExportableSuggestion } from "../lib/testcoverage/exporters/types.js";
import { assertDraftsPublishable } from "../lib/reviews/approval-gate.js";
import { createJiraClient } from "../lib/connectors/jira/jira-client.js";
import { loadResolvedTestManagementConnection } from "../lib/connectors/testmgmt/connection-service.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
});

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actorFromReq(req: Request) {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

async function ensureProject(projectId: string) {
  const project = await getProject(projectId);
  if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
  if (project.status === "archived") {
    throw new AppError(409, "PROJECT_ARCHIVED", "Cannot mutate an archived project");
  }
  return project;
}

const PasteBodySchema = z.object({
  source: z.enum(["csv", "markdown", "gherkin"]),
  text: z.string().min(1).max(2_000_000),
  label: z.string().min(1).max(200),
  columnOverrides: z.record(z.string(), z.string()).optional(),
});

type ColumnOverrideMap = Parameters<
  import("../lib/testcoverage/providers/types.js").ImportProvider["parse"]
>[1]["columnOverrides"];

function castOverrides(raw: Record<string, string> | undefined): ColumnOverrideMap {
  return raw as ColumnOverrideMap;
}

export interface TestCoverageRouterDeps {
  /**
   * Pluggable hook for the background runner (#862). Tests inject a fake; in
   * production the route lazily builds one backed by the task runner.
   */
  enqueueRun?: (input: { runId: string; projectId: string }) => Promise<void> | void;
  /**
   * Optional Socket.IO emitter for run lifecycle events. When omitted the
   * runner runs silently — useful in tests and CLI contexts.
   */
  emitter?: TestCoverageEmitter;
  /**
   * Optional LLM bridge for the judge + suggestion phases (#886). When
   * omitted, the default runner falls back to the module-level runtime
   * config wired in `server.ts`. Tests inject a fake directly.
   */
  caller?: JudgeModelCaller;
}

export function testCoverageRouter(deps: TestCoverageRouterDeps = {}): Router {
  const r = Router({ mergeParams: true });
  const enqueueRun =
    deps.enqueueRun ?? createDefaultEnqueueRun({ emitter: deps.emitter, caller: deps.caller });

  // ---- imports ------------------------------------------------------------

  r.post(
    "/imports",
    requireAuth,
    requirePermission("document.upload"),
    upload.single("file"),
    async (req: Request, res: Response, next) => {
      try {
        const projectId = String(req.params.projectId);
        await ensureProject(projectId);
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) throw new AppError(400, "FILE_REQUIRED", "Upload a file under `file`");
        const label = String(req.body.label ?? file.originalname);
        const columnOverridesRaw = req.body.columnOverrides;
        const columnOverrides =
          typeof columnOverridesRaw === "string"
            ? safeParseOverrides(columnOverridesRaw)
            : undefined;
        const provider = detectProviderForUpload(file.originalname, file.mimetype);
        if (!provider) {
          throw new AppError(415, "UNSUPPORTED_TYPE", "Unsupported import file type");
        }
        const result = await provider.parse(file.buffer, {
          label,
          columnOverrides: castOverrides(columnOverrides),
        });
        const actor = actorFromReq(req);
        const imp = await persistImport({
          projectId,
          source: provider.source,
          label,
          result,
        });
        audit({
          actor: { id: actor.id },
          action: "test-coverage.import",
          target: { type: "project", id: projectId },
          args: { importId: imp.id, source: provider.source, count: result.cases.length },
        });
        res
          .status(201)
          .json(ok({ importId: imp.id, cases: result.cases.length, notes: result.notes }));
      } catch (err) {
        if (err instanceof ColumnMappingRequiredError) {
          return next(
            new AppError(422, "COLUMN_MAPPING_REQUIRED", err.message, {
              fields: err.suggestion,
              confidence: err.confidence,
            }),
          );
        }
        next(err);
      }
    },
  );

  r.post(
    "/imports/paste",
    requireAuth,
    requirePermission("document.upload"),
    async (req: Request, res: Response, next) => {
      try {
        const actor = actorFromReq(req);
        const projectId = String(req.params.projectId);
        await ensureProject(projectId);
        const body = PasteBodySchema.parse(req.body);
        const provider = resolveProvider(body.source);
        const result = await provider.parse(Buffer.from(body.text, "utf8"), {
          label: body.label,
          columnOverrides: castOverrides(body.columnOverrides),
        });
        const imp = await persistImport({
          projectId,
          source: body.source,
          label: body.label,
          result,
        });
        audit({
          actor: { id: actor.id },
          action: "test-coverage.import",
          target: { type: "project", id: projectId },
          args: { importId: imp.id, source: body.source, count: result.cases.length },
        });
        res
          .status(201)
          .json(ok({ importId: imp.id, cases: result.cases.length, notes: result.notes }));
      } catch (err) {
        if (err instanceof ColumnMappingRequiredError) {
          return next(
            new AppError(422, "COLUMN_MAPPING_REQUIRED", err.message, {
              fields: err.suggestion,
              confidence: err.confidence,
            }),
          );
        }
        next(err);
      }
    },
  );

  r.get("/imports", requireAuth, requirePermission("project.read"), async (req, res, next) => {
    try {
      const projectId = String(req.params.projectId);
      const imports = await prisma.testCaseImport.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      res.json(ok(imports));
    } catch (err) {
      next(err);
    }
  });

  // ---- runs ---------------------------------------------------------------

  r.post("/runs", requireAuth, requirePermission("analysis.run"), async (req, res, next) => {
    try {
      const projectId = String(req.params.projectId);
      await ensureProject(projectId);
      const body = CreateRunBodySchema.parse(req.body ?? {});
      const existing = await prisma.testCoverageRun.findFirst({
        where: { projectId, status: { in: ["queued", "running"] } },
      });
      if (existing) {
        throw new AppError(409, "RUN_IN_PROGRESS", "A test-coverage run is already in progress", {
          runId: existing.id,
        });
      }
      const cases = await prisma.testCaseDoc.findMany({
        where: { projectId },
        select: { contentHash: true },
      });
      const contentHash = hashRunInput(cases.map((c) => c.contentHash));
      const actor = actorFromReq(req);
      const run = await prisma.testCoverageRun.create({
        data: {
          projectId,
          createdById: actor.id,
          mode: body.mode,
          status: "queued",
          contentHash,
        },
      });
      audit({
        actor: { id: actor.id },
        action: "test-coverage.run.start",
        target: { type: "project", id: projectId },
        args: { runId: run.id, mode: body.mode },
      });
      // Fire-and-forget. The handler is registered by #862.
      Promise.resolve(enqueueRun({ runId: run.id, projectId })).catch(() => {
        /* errors surfaced via run.status persisted by the runner */
      });
      res.status(202).json(ok(run));
    } catch (err) {
      next(err);
    }
  });

  r.get("/runs", requireAuth, requirePermission("project.read"), async (req, res, next) => {
    try {
      const projectId = String(req.params.projectId);
      const runs = await prisma.testCoverageRun.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      res.json(ok(runs));
    } catch (err) {
      next(err);
    }
  });

  r.get("/runs/:runId", requireAuth, requirePermission("project.read"), async (req, res, next) => {
    try {
      const run = await prisma.testCoverageRun.findFirst({
        where: { id: String(req.params.runId), projectId: String(req.params.projectId) },
      });
      if (!run) throw new AppError(404, "RUN_NOT_FOUND", "Run not found");
      res.json(ok(run));
    } catch (err) {
      next(err);
    }
  });

  // ---- budget (Epic #856 issue #878) --------------------------------------
  r.get(
    "/runs/:runId/budget",
    requireAuth,
    requirePermission("project.read"),
    async (req, res, next) => {
      try {
        const projectId = String(req.params.projectId);
        const runId = String(req.params.runId);
        const run = await prisma.testCoverageRun.findFirst({ where: { id: runId, projectId } });
        if (!run) throw new AppError(404, "RUN_NOT_FOUND", "Run not found");
        const view = await readBudget(runId, { budgetCents: DEFAULT_BUDGET_CENTS });
        res.json(ok(view));
      } catch (err) {
        next(err);
      }
    },
  );

  // ---- reports / gaps / suggestions --------------------------------------

  r.get(
    "/runs/:runId/report",
    requireAuth,
    requirePermission("project.read"),
    async (req, res, next) => {
      try {
        const projectId = String(req.params.projectId);
        const runId = String(req.params.runId);
        const run = await prisma.testCoverageRun.findFirst({ where: { id: runId, projectId } });
        if (!run) throw new AppError(404, "RUN_NOT_FOUND", "Run not found");
        const [mappings, gaps, suggestions] = await Promise.all([
          prisma.coverageMapping.findMany({ where: { runId } }),
          prisma.gapItem.findMany({ where: { runId } }),
          prisma.suggestion.findMany({ where: { runId } }),
        ]);
        const total = mappings.length + gaps.length;
        const covered = mappings.filter(
          (m) => m.status === "COVERED" || m.status === "OVERRIDDEN",
        ).length;
        res.json(
          ok({
            run,
            summary: {
              total,
              covered,
              gaps: gaps.length,
              suggestions: suggestions.length,
              coveragePct: total === 0 ? 0 : Math.round((covered / total) * 100),
            },
            mappings,
            gaps,
            suggestions,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  r.patch(
    "/mappings/:mappingId",
    requireAuth,
    requirePermission("project.update"),
    async (req, res, next) => {
      try {
        const body = OverrideMappingBodySchema.parse(req.body);
        const actor = actorFromReq(req);
        const updated = await prisma.coverageMapping.update({
          where: { id: String(req.params.mappingId) },
          data: {
            status: body.status === "COVERED" ? "OVERRIDDEN" : body.status,
            overriddenById: actor.id,
            overrideReason: body.reason,
          },
        });
        audit({
          actor: { id: actor.id },
          action: "test-coverage.mapping.override",
          target: { type: "coverage_mapping", id: updated.id },
          args: { status: body.status, reason: body.reason },
        });
        res.json(ok(updated));
      } catch (err) {
        next(err);
      }
    },
  );

  r.patch(
    "/suggestions/:suggestionId",
    requireAuth,
    requirePermission("project.update"),
    async (req, res, next) => {
      try {
        const body = AcceptSuggestionBodySchema.parse(req.body);
        const actor = actorFromReq(req);
        const updated = await prisma.suggestion.update({
          where: { id: String(req.params.suggestionId) },
          data: { status: body.status },
        });
        audit({
          actor: { id: actor.id },
          action: "test-coverage.suggestion.update",
          target: { type: "suggestion", id: updated.id },
          args: { status: body.status, reason: body.reason },
        });
        res.json(ok(updated));
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * POST /:projectId/test-coverage/exports
   *
   * Body:
   *   { runId: string,
   *     target: "excel" | "gherkin" | "github" | "xray" | "jira" | "zephyr" | "testrail",
   *     suggestionIds?: string[],
   *     overrideLowConfidence?: boolean,
   *     connection?: object,         // required for github/xray/jira/zephyr/testrail
   *     options?: object }            // per-target options (projectKey, sectionId, repo …)
   *
   * Excel / Gherkin: streams a binary download.
   * github / xray / zephyr / testrail / jira (alias→xray): pushes to the
   * external system and returns `ExporterPushResult` JSON.
   *
   * Low-confidence suggestions (`faithfulness < 0.6`) are rejected unless
   * `overrideLowConfidence === true` (audit-logged).
   */
  r.post("/exports", requireAuth, requirePermission("project.update"), async (req, res, next) => {
    try {
      const projectId = String(req.params.projectId);
      await ensureProject(projectId);
      const actor = actorFromReq(req);
      const ExportBody = z.object({
        runId: z.string().min(1),
        target: z.enum([
          "excel",
          "gherkin",
          "playwright-pom",
          "github",
          "xray",
          "jira",
          "zephyr",
          "testrail",
        ]),
        suggestionIds: z.array(z.string()).optional(),
        overrideLowConfidence: z.boolean().optional(),
        connection: z.record(z.string(), z.unknown()).optional(),
        options: z.record(z.string(), z.unknown()).optional(),
      });
      const body = ExportBody.parse(req.body);

      const report = await buildCoverageReport({
        prisma,
        runId: body.runId,
        projectId,
      });
      if (!report) {
        throw new AppError(404, "RUN_NOT_FOUND", "Coverage run not found");
      }

      if (body.target === "excel") {
        const result = await exportCoverageReportToExcel(report);
        audit({
          actor: { id: actor.id },
          action: "test-coverage.export",
          target: { type: "run", id: body.runId },
          args: { target: "excel" },
        });
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
        res.send(result.data);
        return;
      }

      // For every non-excel target we first filter the suggestion set and
      // enforce the low-confidence gate.
      const requested = new Set(body.suggestionIds ?? []);
      const candidates: ExportableSuggestion[] =
        requested.size === 0
          ? [...report.suggestions]
          : report.suggestions.filter((s) => requested.has(s.id));

      const lowConfBlocked = candidates.filter((s) => s.lowConfidence);
      if (lowConfBlocked.length > 0 && !body.overrideLowConfidence) {
        throw new AppError(
          400,
          "LOW_CONFIDENCE_BLOCKED",
          "Low-confidence suggestions require an explicit override",
          { suggestionIds: lowConfBlocked.map((s) => s.id) },
        );
      }
      if (lowConfBlocked.length > 0 && body.overrideLowConfidence) {
        audit({
          actor: { id: actor.id },
          action: "test-coverage.export.low-confidence-override",
          target: { type: "run", id: body.runId },
          args: { suggestionIds: lowConfBlocked.map((s) => s.id) },
        });
      }

      if (body.target === "gherkin") {
        const result = await exportSuggestionsToGherkin(candidates, {
          defaultFeatureName: `Coverage Run ${body.runId}`,
        });
        audit({
          actor: { id: actor.id },
          action: "test-coverage.export",
          target: { type: "run", id: body.runId },
          args: { target: "gherkin", count: candidates.length },
        });
        const mime = result.kind === "zip" ? "application/zip" : "text/plain; charset=utf-8";
        res.setHeader("Content-Type", mime);
        res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
        res.send(result.kind === "zip" ? result.data : result.text);
        return;
      }

      if (body.target === "playwright-pom") {
        const result = await exportSuggestionsToPlaywrightPom(candidates, {
          defaultFeatureName: `Coverage Run ${body.runId}`,
        });
        audit({
          actor: { id: actor.id },
          action: "test-coverage.export",
          target: { type: "run", id: body.runId },
          args: { target: "playwright-pom", count: candidates.length },
        });
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
        res.send(result.data);
        return;
      }

      // External push targets — connection + options required.
      const opts = (body.options ?? {}) as Record<string, unknown>;
      const conn = (body.connection ?? {}) as Record<string, unknown>;

      // #619 approval gate (PR #638 review, M1). `github` is gated
      // transitively through createBatch inside its exporter; the remaining
      // push targets (xray / its jira alias, zephyr, testrail) write
      // requirement-derived test cases to external systems and must pass the
      // same gate. Suggestions are checked exactly as the GitHub exporter
      // materializes them into drafts (`metadata.mappedRequirementIds`; a
      // suggestion mapped to no requirement counts as unlinked and blocks).
      // Dry-run pushes stay exempt (preview only, no external writes), as do
      // the local file downloads above (excel/gherkin/playwright-pom —
      // documented exemption: they write to no external system, analogous to
      // dry-run previews). Fail-closed: 409 APPROVAL_REQUIRED / 503
      // APPROVAL_GATE_UNAVAILABLE, audited via the gate module.
      const externalPushTargets: ReadonlyArray<typeof body.target> = [
        "xray",
        "jira",
        "zephyr",
        "testrail",
      ];
      if (externalPushTargets.includes(body.target) && !opts.dryRun) {
        await assertDraftsPublishable({
          projectId,
          drafts: candidates.map((s) => ({
            id: s.id,
            requirementId: s.mappedRequirementIds[0] ?? null,
            metadata: JSON.stringify({ mappedRequirementIds: [...s.mappedRequirementIds] }),
          })),
          context: `test-coverage.export.${body.target}`,
          actorId: actor.id,
        });
      }

      if (body.target === "github") {
        const targetOwner = String(opts.targetOwner ?? "");
        const targetRepo = String(opts.targetRepo ?? "");
        if (!targetOwner || !targetRepo) {
          throw new AppError(
            400,
            "EXPORT_OPTIONS_REQUIRED",
            "github export requires options.targetOwner + options.targetRepo",
          );
        }
        const result = await exportSuggestionsToGithub(candidates, {
          projectId,
          targetOwner,
          targetRepo,
          actorId: actor.id,
          secretRef: opts.secretRef ? String(opts.secretRef) : undefined,
          additionalLabels: Array.isArray(opts.additionalLabels)
            ? (opts.additionalLabels as string[])
            : undefined,
          milestone: typeof opts.milestone === "number" ? opts.milestone : undefined,
          dryRun: Boolean(opts.dryRun),
          confirmCrossProject: Boolean(opts.confirmCrossProject),
        });
        audit({
          actor: { id: actor.id },
          action: "test-coverage.export",
          target: { type: "run", id: body.runId },
          args: { target: "github", count: candidates.length, dryRun: Boolean(opts.dryRun) },
        });
        res.json(ok(result));
        return;
      }

      if (body.target === "xray" || body.target === "jira") {
        const baseUrl = String(conn.baseUrl ?? "");
        const clientId = String(conn.clientId ?? "");
        const clientSecret = String(conn.clientSecret ?? "");
        const projectKey = String(opts.projectKey ?? "");
        if (!baseUrl || !clientId || !clientSecret || !projectKey) {
          throw new AppError(
            400,
            "EXPORT_CONNECTION_REQUIRED",
            "xray/jira export requires connection {baseUrl,clientId,clientSecret} + options.projectKey",
          );
        }
        const result = await exportSuggestionsToXray(
          candidates,
          { baseUrl, clientId, clientSecret },
          { projectKey, dryRun: Boolean(opts.dryRun) },
        );
        audit({
          actor: { id: actor.id },
          action: "test-coverage.export",
          target: { type: "run", id: body.runId },
          args: { target: body.target, count: candidates.length, dryRun: Boolean(opts.dryRun) },
        });
        res.json(ok(result));
        return;
      }

      if (body.target === "zephyr") {
        const baseUrl = String(conn.baseUrl ?? "");
        const bearerToken = String(conn.bearerToken ?? "");
        const projectKey = String(opts.projectKey ?? "");
        if (!baseUrl || !bearerToken || !projectKey) {
          throw new AppError(
            400,
            "EXPORT_CONNECTION_REQUIRED",
            "zephyr export requires connection {baseUrl,bearerToken} + options.projectKey",
          );
        }
        const result = await exportSuggestionsToZephyr(
          candidates,
          { baseUrl, bearerToken },
          {
            projectKey,
            folderId: typeof opts.folderId === "number" ? opts.folderId : undefined,
            dryRun: Boolean(opts.dryRun),
          },
        );
        audit({
          actor: { id: actor.id },
          action: "test-coverage.export",
          target: { type: "run", id: body.runId },
          args: { target: "zephyr", count: candidates.length, dryRun: Boolean(opts.dryRun) },
        });
        res.json(ok(result));
        return;
      }

      if (body.target === "testrail") {
        const baseUrl = String(conn.baseUrl ?? "");
        const email = String(conn.email ?? "");
        const apiKey = String(conn.apiKey ?? "");
        const sectionId = typeof opts.sectionId === "number" ? opts.sectionId : NaN;
        if (!baseUrl || !email || !apiKey || !Number.isFinite(sectionId)) {
          throw new AppError(
            400,
            "EXPORT_CONNECTION_REQUIRED",
            "testrail export requires connection {baseUrl,email,apiKey} + options.sectionId",
          );
        }
        const result = await exportSuggestionsToTestRail(
          candidates,
          { baseUrl, email, apiKey },
          {
            sectionId,
            templateId: typeof opts.templateId === "number" ? opts.templateId : undefined,
            dryRun: Boolean(opts.dryRun),
          },
        );
        audit({
          actor: { id: actor.id },
          action: "test-coverage.export",
          target: { type: "run", id: body.runId },
          args: { target: "testrail", count: candidates.length, dryRun: Boolean(opts.dryRun) },
        });
        res.json(ok(result));
        return;
      }

      throw new AppError(400, "EXPORT_TARGET_UNSUPPORTED", `Unsupported target: ${body.target}`);
    } catch (err) {
      next(err);
    }
  });

  // ---- connector pull imports --------------------------------------------
  // Issue: PR #879 review — provide HTTP entry points for Jira / Xray /
  // Zephyr / TestRail importers so the UI can pull cases without a file
  // upload. Body shape mirrors the export route: `connection` + `options`
  // are inlined per request (credentials never persisted by this route).

  const ConnectorImportBaseSchema = z.object({
    label: z.string().min(1).max(200).optional(),
  });

  r.post(
    "/imports/jira",
    requireAuth,
    requirePermission("document.upload"),
    async (req, res, next) => {
      try {
        const projectId = String(req.params.projectId);
        await ensureProject(projectId);
        const actor = actorFromReq(req);
        const body = ConnectorImportBaseSchema.extend({
          edition: z.enum(["cloud", "datacenter"]).default("cloud"),
          baseUrl: z.string().url(),
          username: z.string().min(1),
          apiToken: z.string().min(1),
          projectKey: z.string().min(1),
          extraJql: z.string().optional(),
          pageSize: z.number().int().positive().max(200).optional(),
        }).parse(req.body);

        const client = createJiraClient({
          edition: body.edition,
          baseUrl: body.baseUrl,
          username: body.username,
          apiToken: body.apiToken,
        });
        const result = await importJiraTestCases(client, {
          projectKey: body.projectKey,
          extraJql: body.extraJql,
          pageSize: body.pageSize,
        });
        const label = body.label ?? `Jira ${body.projectKey}`;
        const imp = await persistImport({
          projectId,
          source: "jira",
          label,
          result: { cases: [...result.cases], confidence: 1, notes: [] },
        });
        audit({
          actor: { id: actor.id },
          action: "test-coverage.import.connector",
          target: { type: "project", id: projectId },
          args: { importId: imp.id, source: "jira", count: result.cases.length },
        });
        res.status(201).json(
          ok({
            id: imp.id,
            source: "jira",
            label,
            casesParsed: result.fetched,
            casesUpserted: result.cases.length,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/imports/xray",
    requireAuth,
    requirePermission("document.upload"),
    async (req, res, next) => {
      try {
        const projectId = String(req.params.projectId);
        await ensureProject(projectId);
        const actor = actorFromReq(req);
        const body = ConnectorImportBaseSchema.extend({
          connectionId: z.string().min(1).optional(),
          baseUrl: z.string().url().optional(),
          clientId: z.string().min(1).optional(),
          clientSecret: z.string().min(1).optional(),
          projectKey: z.string().min(1),
          pageSize: z.number().int().positive().max(200).optional(),
        }).parse(req.body);

        let creds: { baseUrl: string; clientId: string; clientSecret: string };
        if (body.connectionId) {
          const resolved = await loadResolvedTestManagementConnection(body.connectionId, projectId);
          if (resolved.kind !== "xray" || resolved.auth.kind !== "xray") {
            throw new AppError(
              400,
              "CONNECTION_KIND_MISMATCH",
              `connection ${body.connectionId} is kind '${resolved.kind}', expected 'xray'`,
            );
          }
          creds = {
            baseUrl: resolved.baseUrl,
            clientId: resolved.auth.clientId,
            clientSecret: resolved.auth.clientSecret,
          };
        } else {
          if (!body.baseUrl || !body.clientId || !body.clientSecret) {
            throw new AppError(
              400,
              "CONNECTOR_CREDENTIALS_REQUIRED",
              "baseUrl, clientId, and clientSecret are required when connectionId is not provided",
            );
          }
          creds = {
            baseUrl: body.baseUrl,
            clientId: body.clientId,
            clientSecret: body.clientSecret,
          };
        }

        const result = await importXrayTests(creds, {
          projectKey: body.projectKey,
          pageSize: body.pageSize,
        });
        const label = body.label ?? `Xray ${body.projectKey}`;
        const imp = await persistImport({
          projectId,
          source: "xray",
          label,
          result: { cases: [...result.cases], confidence: 1, notes: [] },
        });
        audit({
          actor: { id: actor.id },
          action: "test-coverage.import.connector",
          target: { type: "project", id: projectId },
          args: {
            importId: imp.id,
            source: "xray",
            count: result.cases.length,
            connectionId: body.connectionId ?? null,
          },
        });
        res.status(201).json(
          ok({
            id: imp.id,
            source: "xray",
            label,
            casesParsed: result.fetched,
            casesUpserted: result.cases.length,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/imports/zephyr",
    requireAuth,
    requirePermission("document.upload"),
    async (req, res, next) => {
      try {
        const projectId = String(req.params.projectId);
        await ensureProject(projectId);
        const actor = actorFromReq(req);
        const body = ConnectorImportBaseSchema.extend({
          connectionId: z.string().min(1).optional(),
          baseUrl: z.string().url().optional(),
          bearerToken: z.string().min(1).optional(),
          projectKey: z.string().min(1),
          folderId: z.number().int().optional(),
          pageSize: z.number().int().positive().max(200).optional(),
        }).parse(req.body);

        let creds: { baseUrl: string; bearerToken: string };
        if (body.connectionId) {
          const resolved = await loadResolvedTestManagementConnection(body.connectionId, projectId);
          if (resolved.kind !== "zephyr" || resolved.auth.kind !== "zephyr") {
            throw new AppError(
              400,
              "CONNECTION_KIND_MISMATCH",
              `connection ${body.connectionId} is kind '${resolved.kind}', expected 'zephyr'`,
            );
          }
          creds = { baseUrl: resolved.baseUrl, bearerToken: resolved.auth.bearerToken };
        } else {
          if (!body.baseUrl || !body.bearerToken) {
            throw new AppError(
              400,
              "CONNECTOR_CREDENTIALS_REQUIRED",
              "baseUrl and bearerToken are required when connectionId is not provided",
            );
          }
          creds = { baseUrl: body.baseUrl, bearerToken: body.bearerToken };
        }

        const result = await importZephyrCases(creds, {
          projectKey: body.projectKey,
          folderId: body.folderId,
          pageSize: body.pageSize,
        });
        const label = body.label ?? `Zephyr ${body.projectKey}`;
        const imp = await persistImport({
          projectId,
          source: "zephyr",
          label,
          result: { cases: [...result.cases], confidence: 1, notes: [] },
        });
        audit({
          actor: { id: actor.id },
          action: "test-coverage.import.connector",
          target: { type: "project", id: projectId },
          args: {
            importId: imp.id,
            source: "zephyr",
            count: result.cases.length,
            connectionId: body.connectionId ?? null,
          },
        });
        res.status(201).json(
          ok({
            id: imp.id,
            source: "zephyr",
            label,
            casesParsed: result.fetched,
            casesUpserted: result.cases.length,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/imports/testrail",
    requireAuth,
    requirePermission("document.upload"),
    async (req, res, next) => {
      try {
        const metisProjectId = String(req.params.projectId);
        await ensureProject(metisProjectId);
        const actor = actorFromReq(req);
        const body = ConnectorImportBaseSchema.extend({
          connectionId: z.string().min(1).optional(),
          baseUrl: z.string().url().optional(),
          email: z.string().email().optional(),
          apiKey: z.string().min(1).optional(),
          projectId: z.number().int().positive(),
          suiteId: z.number().int().positive().optional(),
          pageSize: z.number().int().positive().max(250).optional(),
        }).parse(req.body);

        let creds: { baseUrl: string; email: string; apiKey: string };
        if (body.connectionId) {
          const resolved = await loadResolvedTestManagementConnection(
            body.connectionId,
            metisProjectId,
          );
          if (resolved.kind !== "testrail" || resolved.auth.kind !== "testrail") {
            throw new AppError(
              400,
              "CONNECTION_KIND_MISMATCH",
              `connection ${body.connectionId} is kind '${resolved.kind}', expected 'testrail'`,
            );
          }
          creds = {
            baseUrl: resolved.baseUrl,
            email: resolved.auth.email,
            apiKey: resolved.auth.apiKey,
          };
        } else {
          if (!body.baseUrl || !body.email || !body.apiKey) {
            throw new AppError(
              400,
              "CONNECTOR_CREDENTIALS_REQUIRED",
              "baseUrl, email, and apiKey are required when connectionId is not provided",
            );
          }
          creds = { baseUrl: body.baseUrl, email: body.email, apiKey: body.apiKey };
        }

        const result = await importTestRailCases(creds, {
          projectId: body.projectId,
          suiteId: body.suiteId,
          pageSize: body.pageSize,
        });
        const label = body.label ?? `TestRail project ${body.projectId}`;
        const imp = await persistImport({
          projectId: metisProjectId,
          source: "testrail",
          label,
          result: { cases: [...result.cases], confidence: 1, notes: [] },
        });
        audit({
          actor: { id: actor.id },
          action: "test-coverage.import.connector",
          target: { type: "project", id: metisProjectId },
          args: {
            importId: imp.id,
            source: "testrail",
            count: result.cases.length,
            connectionId: body.connectionId ?? null,
          },
        });
        res.status(201).json(
          ok({
            id: imp.id,
            source: "testrail",
            label,
            casesParsed: result.fetched,
            casesUpserted: result.cases.length,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // ---- JUnit round-trip upload (Epic #260, issue #45) --------------------
  //
  // POST /:projectId/test-coverage/junit
  //   multipart field `file`: a JUnit XML results document.
  //   optional body `runId`: the coverage run whose mappings receive the
  //   verdict (defaults to the most recent completed run for the project).
  //
  // Matches each <testcase> name to a TestCaseDoc, propagates pass/fail/skip
  // into the linked CoverageMapping.lastResult, and returns an upload summary
  // in which unmatched + ambiguous test cases are reported explicitly.
  r.post(
    "/junit",
    requireAuth,
    requirePermission("analysis.run"),
    upload.single("file"),
    async (req: Request, res: Response, next) => {
      try {
        const projectId = String(req.params.projectId);
        await ensureProject(projectId);
        const actor = actorFromReq(req);
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) throw new AppError(400, "FILE_REQUIRED", "Upload a JUnit XML file under `file`");

        // Resolve the target run: explicit runId, else most-recent completed.
        const requestedRunId = req.body?.runId ? String(req.body.runId) : undefined;
        const run = requestedRunId
          ? await prisma.testCoverageRun.findFirst({
              where: { id: requestedRunId, projectId },
            })
          : await prisma.testCoverageRun.findFirst({
              where: { projectId, status: "completed" },
              orderBy: { createdAt: "desc" },
            });
        if (!run) {
          throw new AppError(
            404,
            "RUN_NOT_FOUND",
            "No coverage run found to attach JUnit results to",
          );
        }

        const xml = file.buffer.toString("utf8");
        const results = parseJUnitXml(xml);
        const summary = await applyJunitResults({
          prisma,
          projectId,
          runId: run.id,
          results,
          runRef: file.originalname,
        });

        audit({
          actor: { id: actor.id },
          action: "test-coverage.junit.upload",
          target: { type: "run", id: run.id },
          args: {
            total: summary.total,
            matched: summary.matched,
            updated: summary.updated,
            unmatched: summary.unmatched.length,
            ambiguous: summary.ambiguous.length,
          },
        });

        res.status(200).json(ok({ runId: run.id, ...summary }));
      } catch (err) {
        if (err instanceof JunitParseError) {
          return next(new AppError(422, "JUNIT_PARSE_FAILED", err.message));
        }
        next(err);
      }
    },
  );

  return r;
}

// ---- helpers --------------------------------------------------------------

function safeParseOverrides(raw: string): Record<string, string> | undefined {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, string>;
  } catch {
    /* ignore */
  }
  return undefined;
}

async function persistImport(args: {
  projectId: string;
  source: string;
  label: string;
  result: ImportProviderResult;
}): Promise<{ id: string }> {
  const { projectId, source, label, result } = args;
  return prisma.$transaction(async (tx) => {
    const imp = await tx.testCaseImport.create({
      data: {
        projectId,
        source,
        label,
        status: "completed",
        testCount: result.cases.length,
      },
      select: { id: true },
    });
    for (const partial of result.cases) {
      const tc = finaliseCase(partial, source as Parameters<typeof finaliseCase>[1]);
      if (!tc) continue;
      const hash = hashCase(tc);
      const externalId = tc.externalId ?? `${imp.id}:${hash}`;
      await tx.testCaseDoc.upsert({
        where: {
          projectId_source_externalId: { projectId, source, externalId },
        },
        create: {
          projectId,
          sourceImportId: imp.id,
          source,
          externalId,
          title: tc.title,
          preconditions: tc.preconditions ?? null,
          stepsJson: JSON.stringify(tc.steps),
          expected: tc.expected ?? null,
          priority: tc.priority,
          tags: JSON.stringify(tc.tags),
          contentHash: hash,
        },
        update: {
          sourceImportId: imp.id,
          title: tc.title,
          preconditions: tc.preconditions ?? null,
          stepsJson: JSON.stringify(tc.steps),
          expected: tc.expected ?? null,
          priority: tc.priority,
          tags: JSON.stringify(tc.tags),
          contentHash: hash,
        },
      });
    }
    return imp;
  });
}
