/**
 * /api/projects — project CRUD (Phase 5 / issue #38).
 *
 * Permission keys (`project.create`, `project.read`, `project.update`,
 * `project.delete`) are enforced via the existing `requirePermission`
 * middleware. The "owner OR admin" rule for archive/delete lives inside
 * `project-service.ts` because it depends on `createdById` which middleware
 * cannot see.
 */
import { Router, type Request, type Response } from "express";
import {
  type ApiResponse,
  PROJECT_STATUSES,
  type ProjectStatus,
  createProjectWithRepoSchema,
  updateAutopilotSchema,
  updateBudgetSchema,
  updateProjectSchema,
  updateSafetyModeSchema,
  updateDatabaseAwareAnalysisSchema,
  updateSqlLineageSchema,
  recordChronicleEntrySchema,
  updateChronicleSettingsSchema,
  updateProjectAutoApproveSchema,
  publishDestinationConfigSchema,
  reviewGateConfigSchema,
  updateAllowCredentialScanSchema,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { assertProjectAccess } from "../lib/custom-agents/authz.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { audit } from "../lib/audit/audit-service.js";
import { seedDefaultTemplates } from "../lib/publishing/template-service.js";
import {
  archiveProject,
  createProject,
  deleteProject,
  getProject,
  getProjectDatabaseAwareAnalysis,
  getProjectSqlLineage,
  listProjects,
  ProjectError,
  updateProject,
  updateProjectAutopilot,
  updateProjectBudget,
  updateProjectDatabaseAwareAnalysis,
  updateProjectSafetyMode,
  updateProjectSqlLineage,
} from "../lib/projects/project-service.js";
import { summarizeUsage } from "../lib/finops/index.js";
import { prisma } from "../lib/prisma.js";
import { createRepoConnector } from "../lib/connectors/repo/repo-service.js";
import { listQuarantine } from "../lib/rag/quarantine.js";
import { forgetEntry, getEntries, recordEntry } from "../lib/memory/chronicle.js";
import {
  getGitHubProjectV2Settings,
  listGitHubProjectsV2Boards,
  updateGitHubProjectV2Settings,
} from "../lib/publishing/github-projects-v2-service.js";
import { PublishError } from "../lib/publishing/types.js";
import { generateOverview, OverviewError } from "../lib/code-graph/overview.js";
import { jobEvents, genericFailureMessage } from "../lib/socket/job-events.js";
import { randomUUID } from "node:crypto";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actorFromReq(req: Request) {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

function rethrow(err: unknown): never {
  if (err instanceof ProjectError) {
    throw new AppError(err.status, err.code, err.message);
  }
  throw err;
}

export function projectsRouter(): Router {
  const r = Router();

  // Epic #671 / #674 — object-level project scope (OWASP A01 / BOLA) for the
  // `/:id/*` SUB-RESOURCE handlers (budget, review-gate, publish-destination,
  // safety, autopilot, quarantine, chronicle, overview, github-projects-v2,
  // etc.). #673 scoped the base `/:id` GET/PATCH/archive/DELETE per-handler; the
  // sub-resources were still object-unscoped. This two-segment `.use` prefix
  // matches `/:id/<sub>...` but NOT the single-segment base `/:id` routes, so it
  // is purely additive — no double-check on the #673-scoped verbs. Non-members
  // of the project's workspace get a 404 (no existence oracle); admins bypass.
  r.use("/:id/:sub", requireAuth, requireProjectAccess("id"));

  // ── List ────────────────────────────────────────────────────────────────
  r.get("/", requireAuth, requirePermission("project.read"), async (req, res) => {
    const status = parseStatus(toScalar(req.query.status));
    const limit = parseInt(toScalar(req.query.limit) ?? "25", 10);
    const offset = parseInt(toScalar(req.query.offset) ?? "0", 10);
    // Admins see all projects unless they scope via query param.
    // Non-admins are always scoped to their workspace memberships from the JWT.
    let workspaceIds: string[] | undefined;
    if (req.user?.role === "admin") {
      // Allow admin to voluntarily scope to a single workspace via ?workspaceId=
      const qWorkspace = toScalar(req.query.workspaceId);
      workspaceIds = qWorkspace ? [qWorkspace] : undefined;
    } else {
      workspaceIds = req.user?.workspaces ?? [];
    }
    const result = await listProjects({ status, limit, offset, workspaceIds });
    res.json(ok(result));
  });

  // ── Read ────────────────────────────────────────────────────────────────
  r.get("/:id", requireAuth, requirePermission("project.read"), async (req, res) => {
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    // Epic #671 / #673 — object-level workspace scope on top of the role
    // (`project.read`) layer. A caller who is not a member of the project's
    // workspace gets a 404 (no existence oracle) BEFORE the by-id lookup runs.
    // Reuses the canonical `assertProjectAccess` seam shared with
    // custom-agents invoke + comments (admins bypass; unassigned projects open).
    await assertProjectAccess(req.user, String(req.params.id));
    const project = await getProject(String(req.params.id));
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    res.json(ok(project));
  });

  // ── Create ──────────────────────────────────────────────────────────────
  r.post("/", requireAuth, requirePermission("project.create"), async (req, res) => {
    const parsed = createProjectWithRepoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid project payload", {
        issues: parsed.error.flatten(),
      });
    }
    const actor = actorFromReq(req);
    try {
      const { primaryRepo, workspaceId: _workspaceId, ...projectData } = parsed.data;
      // Attach workspaceId so createProject can persist it
      const project = await createProject(
        { ...projectData, workspaceId: _workspaceId } as Parameters<typeof createProject>[0],
        actor,
      );

      // Epic #640 — auto-create a primary repo connector if provided.
      let primaryRepoConnector = null;
      if (primaryRepo) {
        try {
          const connector = await createRepoConnector(
            project.id,
            {
              label: "primary",
              provider: primaryRepo.apiBaseUrl ? "github_enterprise" : "github",
              ownerOrOrg: primaryRepo.ownerOrOrg,
              repoName: primaryRepo.repoName,
              apiBaseUrl: primaryRepo.apiBaseUrl ?? null,
              secretRef: primaryRepo.secretRef,
            },
            actor.id,
          );
          // Mark it as primary
          await prisma.repoConnection.update({
            where: { id: connector.id },
            data: { isPrimary: true },
          });
          primaryRepoConnector = { ...connector, isPrimary: true };
        } catch {
          /* non-critical — project creation succeeds even if repo link fails */
        }
      }

      // Epic #595 — seed default issue templates for every new project.
      await seedDefaultTemplates(project.id).catch(() => {
        /* non-critical */
      });
      audit({
        actor: { id: actor.id },
        action: "project.create",
        target: { type: "project", id: project.id },
        metadata: { slug: project.slug },
      });
      res.status(201).json(ok({ ...project, primaryRepo: primaryRepoConnector }));
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Update ──────────────────────────────────────────────────────────────
  r.patch("/:id", requireAuth, requirePermission("project.update"), async (req, res) => {
    const parsed = updateProjectSchema.safeParse({
      ...(req.body ?? {}),
      id: String(req.params.id),
    });
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid project payload", {
        issues: parsed.error.flatten(),
      });
    }
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    // Epic #671 / #673 — scope the by-id mutate to the caller's workspace via
    // the same canonical seam as the read. This closes the cross-tenant path
    // for the `assertCanMutate` coordinator short-circuit: a coordinator in
    // workspace A gets a 404 for a workspace-B project before the mutate runs.
    await assertProjectAccess(req.user, String(req.params.id));
    const actor = actorFromReq(req);
    try {
      const project = await updateProject(parsed.data, actor);
      audit({
        actor: { id: actor.id },
        action: "project.update",
        target: { type: "project", id: project.id },
        metadata: { changed: Object.keys(req.body ?? {}) },
      });
      res.json(ok(project));
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Archive (soft) ──────────────────────────────────────────────────────
  r.post("/:id/archive", requireAuth, requirePermission("project.update"), async (req, res) => {
    // Epic #671 / #674 — this two-segment `/:id/archive` path is covered by the
    // `r.use("/:id/:sub", …)` workspace-scope chokepoint above (which runs
    // BEFORE this handler), so the caller is already confirmed to be a member of
    // the project's workspace here. #673's inline `assertProjectAccess` was
    // removed to avoid a redundant double lookup — the guarantee is unchanged: an
    // out-of-tenant caller gets a 404 before `assertCanArchive` is ever reached.
    const actor = actorFromReq(req);
    try {
      const project = await archiveProject(String(req.params.id), actor);
      audit({
        actor: { id: actor.id },
        action: "project.archive",
        target: { type: "project", id: project.id },
      });
      res.json(ok(project));
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Delete ──────────────────────────────────────────────────────────────
  r.delete(
    "/:id",
    requireAuth,
    requirePermission("project.delete"),
    async (req: Request, res: Response) => {
      // Epic #671 / #673 — workspace scope before the by-PK delete so a foreign
      // project id 404s (not 403) exactly like GET/PATCH/archive, closing the
      // last existence oracle on the same resource. `req.user` is guaranteed by
      // requireAuth.
      await assertProjectAccess(req.user!, String(req.params.id));
      const actor = actorFromReq(req);
      try {
        await deleteProject(String(req.params.id), actor);
        audit({
          actor: { id: actor.id },
          action: "project.delete",
          target: { type: "project", id: String(req.params.id) },
        });
        res.status(204).end();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ── FinOps + safety (Epic #164) ─────────────────────────────────────────

  // GET /api/projects/:id/usage-summary?from=&to=
  // Renamed from /:id/usage to avoid route conflict with Epic #594's
  // projectUsageRouter mounted at /projects/:projectId/usage in index.ts.
  r.get(
    "/:id/usage-summary",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.id);
      const project = await prisma.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { id: true },
      });
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      const window: { from?: Date; to?: Date } = {};
      const from = toScalar(req.query.from);
      const to = toScalar(req.query.to);
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) {
          throw new AppError(400, "VALIDATION_ERROR", "Invalid 'from' timestamp");
        }
        window.from = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) {
          throw new AppError(400, "VALIDATION_ERROR", "Invalid 'to' timestamp");
        }
        window.to = d;
      }
      const summary = await summarizeUsage(projectId, window);
      res.json(ok(summary));
    },
  );

  // GET /api/projects/:id/token-breakdown?range=24h|7d|30d
  r.get(
    "/:id/token-breakdown",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.id);
      const project = await prisma.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { id: true },
      });
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");

      const range = toScalar(req.query.range) ?? "7d";
      const validRanges = ["24h", "7d", "30d"] as const;
      if (!validRanges.includes(range as (typeof validRanges)[number])) {
        throw new AppError(400, "VALIDATION_ERROR", "range must be one of: 24h, 7d, 30d");
      }

      const now = new Date();
      const hoursMap: Record<string, number> = { "24h": 24, "7d": 168, "30d": 720 };
      const hours = hoursMap[range];
      const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
      const prevFrom = new Date(from.getTime() - hours * 60 * 60 * 1000);

      // Current period rows
      const currentRows = await prisma.aITokenUsage.findMany({
        where: { session: { projectId }, ts: { gte: from, lte: now } },
        select: { categoryBreakdown: true, totalTokens: true, ts: true },
      });

      // Previous period rows (for trend comparison)
      const prevRows = await prisma.aITokenUsage.findMany({
        where: { session: { projectId }, ts: { gte: prevFrom, lt: from } },
        select: { categoryBreakdown: true, totalTokens: true },
      });

      const aggregateBreakdown = (
        rows: { categoryBreakdown: string | null; totalTokens: number }[],
      ) => {
        const agg: Record<string, number> = {};
        let totalWithBreakdown = 0;
        for (const row of rows) {
          if (row.categoryBreakdown) {
            try {
              const bd = JSON.parse(row.categoryBreakdown) as Record<string, number>;
              for (const [cat, tokens] of Object.entries(bd)) {
                agg[cat] = (agg[cat] ?? 0) + tokens;
              }
              totalWithBreakdown += row.totalTokens;
            } catch {
              // Skip malformed JSON
            }
          }
        }
        return { breakdown: agg, total: totalWithBreakdown };
      };

      const current = aggregateBreakdown(currentRows);
      const prev = aggregateBreakdown(prevRows);

      // Compute percentages and trends
      const categories = Object.keys(current.breakdown);
      const categoryDetails = categories.map((cat) => {
        const tokens = current.breakdown[cat];
        const percentage = current.total > 0 ? tokens / current.total : 0;
        const prevTokens = prev.breakdown[cat] ?? 0;
        const trend = prevTokens > 0 ? (tokens - prevTokens) / prevTokens : null;
        return { category: cat, tokens, percentage, trend };
      });

      // Find biggest category for optimization suggestion
      const biggest = categoryDetails.reduce(
        (a, b) => (a.tokens > b.tokens ? a : b),
        categoryDetails[0] ?? { category: "none", tokens: 0, percentage: 0, trend: null },
      );

      const suggestions: string[] = [];
      if (biggest.category === "tool_manifests" && biggest.percentage > 0.3) {
        suggestions.push(
          "Tool manifests consume >30% of tokens. Consider enabling compact manifest mode.",
        );
      }
      if (biggest.category === "history" && biggest.percentage > 0.35) {
        suggestions.push("Conversation history is large. Consider reducing max history turns.");
      }
      if (biggest.category === "rag_context" && biggest.percentage > 0.4) {
        suggestions.push(
          "RAG context is dominant. Consider refining chunk sizes or relevance thresholds.",
        );
      }

      res.json(
        ok({
          range,
          totalTokens: current.total,
          categories: categoryDetails,
          biggestCategory: biggest.category,
          suggestions,
        }),
      );
    },
  );

  // GET /api/projects/:id/safety-events
  r.get(
    "/:id/safety-events",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.id);
      const verdict = toScalar(req.query.verdict);
      const limit = Math.min(
        Math.max(parseInt(toScalar(req.query.limit) ?? "50", 10) || 50, 1),
        200,
      );
      const where: Record<string, unknown> = { projectId };
      if (verdict) {
        if (!["allowed", "blocked", "redacted"].includes(verdict)) {
          throw new AppError(400, "VALIDATION_ERROR", "verdict must be allowed|blocked|redacted");
        }
        where.verdict = verdict;
      }
      const fromRaw = toScalar(req.query.from);
      const toRaw = toScalar(req.query.to);
      if (fromRaw || toRaw) {
        const range: Record<string, Date> = {};
        if (fromRaw) {
          const d = new Date(fromRaw);
          if (Number.isNaN(d.getTime())) {
            throw new AppError(400, "VALIDATION_ERROR", "Invalid 'from' timestamp");
          }
          range.gte = d;
        }
        if (toRaw) {
          const d = new Date(toRaw);
          if (Number.isNaN(d.getTime())) {
            throw new AppError(400, "VALIDATION_ERROR", "Invalid 'to' timestamp");
          }
          range.lt = d;
        }
        where.createdAt = range;
      }
      const rows = await prisma.safetyEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      res.json(
        ok({
          items: rows.map((r) => ({
            id: r.id,
            projectId: r.projectId,
            sessionId: r.sessionId,
            direction: r.direction,
            verdict: r.verdict,
            findings: parseFindings(r.findings),
            createdAt: r.createdAt.toISOString(),
          })),
        }),
      );
    },
  );

  // PATCH /api/projects/:id/safety  { safetyMode }
  r.patch(
    "/:id/safety",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const parsed = updateSafetyModeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid safety payload", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      try {
        const project = await updateProjectSafetyMode(
          String(req.params.id),
          parsed.data.safetyMode,
          actor,
        );
        res.json(ok(project));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ── Database-aware analysis setting (Epic #852 Phase 3 / #857) ───────────

  // GET /api/projects/:id/database-aware-analysis — raw setting + resolved
  // decision (reuses the SAME resolver wiring the run path (#855) and
  // gap-report path (#856) call, via `resolveProjectDatabaseAware`). Kept as
  // its own endpoint (mirroring `/:id/safety-events` alongside `/:id/safety`)
  // rather than folding into the base project GET, since the resolved
  // decision requires two extra schema-data probe queries — cost the base
  // project read (list/detail) should not pay on every call.
  r.get(
    "/:id/database-aware-analysis",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      try {
        const state = await getProjectDatabaseAwareAnalysis(String(req.params.id));
        res.json(ok(state));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // PATCH /api/projects/:id/database-aware-analysis  { databaseAwareAnalysis }
  r.patch(
    "/:id/database-aware-analysis",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const parsed = updateDatabaseAwareAnalysisSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid database-aware-analysis payload", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      try {
        const project = await updateProjectDatabaseAwareAnalysis(
          String(req.params.id),
          parsed.data.databaseAwareAnalysis,
          actor,
        );
        res.json(ok(project));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ── SQL-lineage setting (Epic #882 Phase 3 / #894) ────────────────────────

  // GET /api/projects/:id/sql-lineage — raw setting + resolved decision +
  // sidecar-configured signal (reuses the SAME resolver the ingest wiring
  // (`buildCodeGraphSchemaWiring`, `db-service.ts`) calls, via
  // `resolveProjectSqlLineage`). Kept as its own endpoint mirroring
  // `/:id/database-aware-analysis` rather than folding into the base project
  // GET.
  r.get(
    "/:id/sql-lineage",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      try {
        const state = await getProjectSqlLineage(String(req.params.id));
        res.json(ok(state));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // PATCH /api/projects/:id/sql-lineage  { sqlLineage }
  r.patch(
    "/:id/sql-lineage",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const parsed = updateSqlLineageSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid sql-lineage payload", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      try {
        const project = await updateProjectSqlLineage(
          String(req.params.id),
          parsed.data.sqlLineage,
          actor,
        );
        res.json(ok(project));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // PATCH /api/projects/:id/budget  { monthlyTokenBudget }
  r.patch(
    "/:id/budget",
    requireAuth,
    requirePermission("admin.write"),
    async (req: Request, res: Response) => {
      const parsed = updateBudgetSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid budget payload", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      try {
        const project = await updateProjectBudget(
          String(req.params.id),
          parsed.data.monthlyTokenBudget,
          actor,
        );
        res.json(ok(project));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // PATCH /api/projects/:id/autopilot  { enabled, costCeilingCents }
  r.patch(
    "/:id/autopilot",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const parsed = updateAutopilotSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid autopilot payload", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      try {
        const project = await updateProjectAutopilot(
          String(req.params.id),
          {
            enabled: parsed.data.enabled,
            costCeilingCents: parsed.data.costCeilingCents ?? null,
          },
          actor,
        );
        res.json(ok(project));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ── Quarantine list (epic #157) ─────────────────────────────────────────
  r.get(
    "/:id/quarantine",
    requireAuth,
    requirePermission("document.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      const items = await listQuarantine(projectId);
      res.json(
        ok({
          items,
          autoApproveTrustedSources: Boolean(project.autoApproveTrustedSources),
        }),
      );
    },
  );

  // ── Toggle project-level auto-approve (epic #157) ───────────────────────
  r.patch(
    "/:id/auto-approve",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const parsed = updateProjectAutoApproveSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid payload", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      const updated = await prisma.project.update({
        where: { id: projectId },
        data: { autoApproveTrustedSources: parsed.data.autoApproveTrustedSources },
      });
      audit({
        actor: { id: actor.id },
        action: "project.autoApproveTrustedSources.update",
        target: { type: "project", id: projectId },
        metadata: { value: parsed.data.autoApproveTrustedSources },
      });
      res.json(ok(updated));
    },
  );

  // ── Allow credential scan toggle (epic #701) ────────────────────────────
  r.patch(
    "/:id/allow-credential-scan",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const parsed = updateAllowCredentialScanSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid payload", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      const updated = await prisma.project.update({
        where: { id: projectId },
        data: { allowCredentialScan: parsed.data.allowCredentialScan },
      });
      audit({
        actor: { id: actor.id },
        action: "project.allowCredentialScan.update",
        target: { type: "project", id: projectId },
        metadata: { value: parsed.data.allowCredentialScan },
      });
      res.json(ok(updated));
    },
  );

  // ── Chronicle settings (epic #157) ──────────────────────────────────────
  r.patch(
    "/:id/chronicle/settings",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const parsed = updateChronicleSettingsSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid chronicle settings", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      const updated = await prisma.project.update({
        where: { id: projectId },
        data: {
          chronicleEnabled: parsed.data.chronicleEnabled,
          ...(parsed.data.chronicleTtlDays != null
            ? { chronicleTtlDays: parsed.data.chronicleTtlDays }
            : {}),
        },
      });
      audit({
        actor: { id: actor.id },
        action: "project.chronicle.update",
        target: { type: "project", id: projectId },
        metadata: {
          chronicleEnabled: parsed.data.chronicleEnabled,
          chronicleTtlDays: parsed.data.chronicleTtlDays ?? null,
        },
      });
      res.json(ok(updated));
    },
  );

  r.get(
    "/:id/chronicle",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      const items = await getEntries(projectId, { limit: 50 });
      res.json(ok({ items, enabled: Boolean(project.chronicleEnabled) }));
    },
  );

  r.post(
    "/:id/chronicle",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const parsed = recordChronicleEntrySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid chronicle entry", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      const entry = await recordEntry(projectId, parsed.data.key, parsed.data.value, {
        actorId: actor.id,
      });
      if (!entry) {
        throw new AppError(409, "CHRONICLE_DISABLED", "Chronicle is disabled for this project");
      }
      res.status(201).json(ok(entry));
    },
  );

  r.delete(
    "/:id/chronicle/:entryId",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const actor = actorFromReq(req);
      const entryId = String(req.params.entryId);
      const ok2 = await forgetEntry(entryId, { id: actor.id });
      if (!ok2) throw new AppError(404, "CHRONICLE_NOT_FOUND", "Entry not found");
      res.status(204).end();
    },
  );

  // ── GitHub Projects v2 settings (Epic #163, Issue #108) ─────────────────
  r.get(
    "/:id/github/projects-v2-settings",
    requireAuth,
    requirePermission("project.read"),
    async (req, res) => {
      try {
        const projectId = String(req.params.id);
        const settings = await getGitHubProjectV2Settings(projectId);
        res.json(ok(settings));
      } catch (err) {
        if (err instanceof PublishError) {
          throw new AppError(err.status, err.code, err.message);
        }
        throw err;
      }
    },
  );
  r.put(
    "/:id/github/projects-v2-settings",
    requireAuth,
    requirePermission("project.update"),
    async (req, res) => {
      try {
        const actor = actorFromReq(req);
        const projectId = String(req.params.id);
        const body = req.body ?? {};
        const githubProjectId =
          typeof body.githubProjectId === "string" || body.githubProjectId === null
            ? (body.githubProjectId as string | null)
            : null;
        const fieldMappings =
          body.fieldMappings && typeof body.fieldMappings === "object"
            ? (body.fieldMappings as Record<string, unknown>)
            : null;
        const updated = await updateGitHubProjectV2Settings(
          projectId,
          { githubProjectId, fieldMappings },
          actor.id,
        );
        res.json(ok(updated));
      } catch (err) {
        if (err instanceof PublishError) {
          throw new AppError(err.status, err.code, err.message);
        }
        throw err;
      }
    },
  );
  r.post(
    "/:id/github/projects-v2-boards",
    requireAuth,
    requirePermission("project.update"),
    async (req, res) => {
      try {
        const body = req.body ?? {};
        const secretRef =
          typeof body.secretRef === "string" && body.secretRef.length > 0 ? body.secretRef : null;
        const targetOwner =
          typeof body.targetOwner === "string" && body.targetOwner.length > 0
            ? body.targetOwner
            : null;
        if (!secretRef || !targetOwner) {
          throw new AppError(400, "VALIDATION_ERROR", "secretRef and targetOwner are required");
        }
        const targetRepo = typeof body.targetRepo === "string" ? body.targetRepo : undefined;
        const targetBaseUrl = typeof body.targetBaseUrl === "string" ? body.targetBaseUrl : null;
        const boards = await listGitHubProjectsV2Boards({
          secretRef,
          targetOwner,
          targetRepo,
          targetBaseUrl,
        });
        res.json(ok(boards));
      } catch (err) {
        if (err instanceof PublishError) {
          throw new AppError(err.status, err.code, err.message);
        }
        throw err;
      }
    },
  );

  // ── Project overview (Epic #298 / Issue #313) ──────────────────────────
  // GET /api/projects/:id/overview
  // Returns the cached `project_overview.md` as text/markdown. 404 when the
  // project has never had its overview generated.
  r.get(
    "/:id/overview",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.id);
      const project = await prisma.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { id: true, overviewMarkdown: true, overviewGeneratedAt: true },
      });
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      if (!project.overviewMarkdown) {
        throw new AppError(
          404,
          "OVERVIEW_NOT_GENERATED",
          "Project overview has not been generated yet. POST /overview/regenerate first.",
        );
      }
      // Return as JSON envelope so the existing UI api-client unwraps it.
      res.json(
        ok({
          markdown: project.overviewMarkdown,
          generatedAt: project.overviewGeneratedAt
            ? project.overviewGeneratedAt.toISOString()
            : null,
        }),
      );
    },
  );

  // POST /api/projects/:id/overview/regenerate
  // Re-runs the overview algorithm against the persisted CodeGraph and
  // caches the result on the Project row. Requires `project.update` because
  // the work is potentially expensive and writes to the project record.
  //
  // Epic #406 (#423) — the regenerate now publishes its progress on the unified
  // `job:lifecycle` bus (kind `overview-regenerate`): a `jobId` is minted and
  // `started` → `completed` / `failed` transitions stream so the UI shows live
  // status instead of a frozen "Regenerating…" label and fires a terminal toast
  // (the success toast that was previously MISSING). The overview build is a fast
  // deterministic AST pass (no LLM), so the result is returned synchronously with
  // the `jobId` — no gateway risk — while the bus drives the live indicator. A
  // failure broadcasts a generic, user-safe message (#254); the precise
  // OverviewError still maps to its proper 4xx for the caller.
  r.post(
    "/:id/overview/regenerate",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.id);
      const actor = actorFromReq(req);
      const project = await prisma.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { id: true },
      });
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");

      const jobId = randomUUID();
      jobEvents.started("overview-regenerate", jobId, projectId, "Regenerating project overview");
      try {
        const result = await generateOverview(prisma, projectId);
        const generatedAt = new Date();
        await prisma.project.update({
          where: { id: projectId },
          data: {
            overviewMarkdown: result.markdown,
            overviewGeneratedAt: generatedAt,
          },
        });
        audit({
          actor: { id: actor.id },
          action: "project.overview.regenerate",
          target: { type: "project", id: projectId },
          metadata: {
            symbolCount: result.stats.symbolCount,
            edgeCount: result.stats.edgeCount,
            godNodeCount: result.stats.godNodeCount,
            entryPointCount: result.stats.entryPointCount,
          },
        });
        jobEvents.completed(
          "overview-regenerate",
          jobId,
          projectId,
          `Overview regenerated from ${result.stats.symbolCount} symbols.`,
        );
        res.json(
          ok({
            markdown: result.markdown,
            generatedAt: generatedAt.toISOString(),
            stats: result.stats,
            jobId,
          }),
        );
      } catch (err) {
        // #254 — the bus gets a generic, user-safe terminal message; the precise
        // OverviewError is still mapped to its proper status for the caller.
        jobEvents.failed(
          "overview-regenerate",
          jobId,
          projectId,
          genericFailureMessage("overview-regenerate"),
        );
        if (err instanceof OverviewError) {
          throw new AppError(err.code === "NO_GRAPH" ? 409 : 404, err.code, err.message);
        }
        throw err;
      }
    },
  );

  // ── Epic #557 — Publishing destination configuration ────────────────────
  r.get(
    "/:id/publish-destination",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      res.json(
        ok({
          publishDestination: project.publishDestination ?? "github",
          jiraProjectKey: project.jiraProjectKey ?? null,
          jiraConnectionId: project.jiraConnectionId ?? null,
        }),
      );
    },
  );

  r.patch(
    "/:id/publish-destination",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const parsed = publishDestinationConfigSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid publishing destination config", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      const projectId = String(req.params.id);
      const project = await getProject(projectId);
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");

      // If jira or both, validate jira connection and project key exist
      if (parsed.data.publishDestination === "jira" || parsed.data.publishDestination === "both") {
        if (!parsed.data.jiraConnectionId) {
          throw new AppError(
            400,
            "JIRA_CONNECTION_REQUIRED",
            "Jira connection ID is required when publishing to Jira",
          );
        }
        if (!parsed.data.jiraProjectKey) {
          throw new AppError(
            400,
            "JIRA_PROJECT_KEY_REQUIRED",
            "Jira project key is required when publishing to Jira",
          );
        }
        // Validate the connection exists
        const conn = await prisma.jiraConnection.findFirst({
          where: { id: parsed.data.jiraConnectionId, projectId, deletedAt: null },
        });
        if (!conn) {
          throw new AppError(
            404,
            "JIRA_CONNECTION_NOT_FOUND",
            "Jira connection not found for this project",
          );
        }
      }

      const updated = await prisma.project.update({
        where: { id: projectId },
        data: {
          publishDestination: parsed.data.publishDestination,
          jiraProjectKey: parsed.data.jiraProjectKey ?? null,
          jiraConnectionId: parsed.data.jiraConnectionId ?? null,
        },
      });
      audit({
        actor: { id: actor.id },
        action: "project.publishDestination.update",
        target: { type: "project", id: projectId },
        metadata: {
          publishDestination: parsed.data.publishDestination,
          jiraProjectKey: parsed.data.jiraProjectKey ?? null,
        },
      });
      res.json(
        ok({
          publishDestination: updated.publishDestination,
          jiraProjectKey: updated.jiraProjectKey,
          jiraConnectionId: updated.jiraConnectionId,
        }),
      );
    },
  );

  // ── Epic #609 (#619) — publish/export approval gate ──────────────────────
  // `requireApprovedReview` defaults to FALSE (gate off — pre-#619 behavior).
  // Reading the setting needs `project.read`; toggling it is a review-
  // governance action and requires `review.admin` (coordinator/admin), so a
  // developer with draft/publish permissions cannot weaken the gate.
  r.get(
    "/:id/review-gate",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.id);
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { requireApprovedReview: true },
      });
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      res.json(ok({ requireApprovedReview: project.requireApprovedReview }));
    },
  );

  r.patch(
    "/:id/review-gate",
    requireAuth,
    requirePermission("review.admin"),
    async (req: Request, res: Response) => {
      const parsed = reviewGateConfigSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid review gate config", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      const projectId = String(req.params.id);
      const existing = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      });
      if (!existing) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");

      const updated = await prisma.project.update({
        where: { id: projectId },
        data: { requireApprovedReview: parsed.data.requireApprovedReview },
      });
      audit({
        actor: { id: actor.id },
        action: "project.reviewGate.update",
        target: { type: "project", id: projectId },
        metadata: { requireApprovedReview: parsed.data.requireApprovedReview },
      });
      res.json(ok({ requireApprovedReview: updated.requireApprovedReview }));
    },
  );

  return r;
}

function parseFindings(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function parseStatus(raw: string | undefined): ProjectStatus | undefined {
  if (!raw) return undefined;
  if ((PROJECT_STATUSES as readonly string[]).includes(raw)) return raw as ProjectStatus;
  throw new AppError(
    400,
    "VALIDATION_ERROR",
    `status must be one of ${PROJECT_STATUSES.join("|")}`,
  );
}

function toScalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}
