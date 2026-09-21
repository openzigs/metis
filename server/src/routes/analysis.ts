/**
 * /api/projects/:projectId/analyses + /api/analyses/:id (Phase 7).
 *
 * Endpoints
 * ─────────
 *   GET  /api/projects/:projectId/analyses        \u2014 list project's runs
 *   POST /api/projects/:projectId/analyses        \u2014 start a new run
 *   GET  /api/analyses/personas                   \u2014 named persona registry
 *   GET  /api/analyses/cost-cap                   \u2014 monthly token usage status
 *   GET  /api/analyses/:id                        \u2014 full snapshot
 *   POST /api/analyses/:id/cancel                 \u2014 cancel an in-flight run
 *   POST /api/analyses/:id/agents/:agentKey/regenerate \u2014 re-run one agent
 *   PATCH /api/analyses/:id/requirements/:reqId   \u2014 approve/reject/edit
 *
 * Provider construction is centralised through the AI engine (offline-stub
 * fallback per the existing factory). Tests inject a deterministic provider
 * via `setOrchestratorForTests`.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import {
  type ApiResponse,
  ANALYSIS_SPECIALIST_AGENT_KEYS,
  MAX_DOCUMENT_BYTES,
  startAnalysisSchema,
  updateRequirementSchema,
  deepDiveFindingSchema,
  publishFindingSchema,
  findingIssueDraftSchema,
  type AnalysisSpecialistAgentKey,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
// Issue #1099 — the top-level `/api/analyses` router has no path project to
// mount `requireProjectAccess` on; it authorizes through this seam instead.
import { assertProjectAccess } from "../lib/custom-agents/authz.js";
import { analysisDeepDiveRateLimiter } from "../middleware/analysis-deepdive-rate-limit.js";
import { AppError } from "../middleware/error-handler.js";
import {
  AnalysisOrchestrator,
  AnalysisNotRegeneratableError,
  CostCapExceededError,
  assertCanStartAnalysis,
  type OrchestratorDeps,
  getAllPersonas,
  getAnalysisSnapshot,
  detectStaticCapability,
  getCostCapStatus,
  getOrchestrator,
  getStructuredRequirements,
  persistAnalysisEnhancement,
  listAnalysesForProject,
  setOrchestratorForTests,
  updateRequirementRow,
  // Epic #597 — requirements enhancement pipeline.
  ClarificationDialog,
  getDialogState,
  listApprovalRequests,
  reviewApprovalRequest,
  canCreateTickets,
  // Issue #1104 (finding B) — release the requirements the gate withheld.
  promoteApprovedRequirements,
  type PromotionOutcome,
  // Epic #176 / #178 — finding deep-dive → issue draft.
  deepDiveFinding,
  loadFindingForDeepDive,
  // Issue #737 — requirement→findings→code→tests traceability matrix + export.
  getTraceabilityMatrix,
  serializeTraceabilityCsv,
  serializeTraceabilityMarkdown,
  // Issue #742 — per-requirement gap report.
  getGapReport,
  // Issue #847 (Epic #820) — production loadSchemaImpact producer wiring: gates
  // + builds the per-requirement `databaseChanges` producer for `getGapReport`.
  resolveGapReportDeps,
  // Issue #744 — markdown / GitHub-issue-draft export.
  buildFindingIssueDraft,
  serializeFindingIssueDraftMarkdown,
  serializeAnalysisReportMarkdown,
} from "../lib/analysis/index.js";
// Issue #743 — diff-style current-vs-proposed view for changed requirements.
import { getRequirementDiff } from "../lib/change-analysis/requirement-diff-service.js";
import type { StructuredRequirements } from "../lib/analysis/types/requirements.js";
// Issue #1116 — carry the submitted answers into the persisted requirement rows
// (and therefore into the drafts/issues they become), not just the metadata the
// approval view reads.
import { applyClarificationsToRequirements } from "../lib/analysis/clarification-enrichment.js";
import {
  serializeClarifyCsv,
  serializeClarifyJson,
  parseClarifyCsv,
  ClarifyCsvError,
  type ClarifyExportRow,
} from "../lib/analysis/clarify-csv.js";
import { audit } from "../lib/audit/audit-service.js";
import { buildProvider, loadAIConfig } from "../lib/ai/index.js";
import { getKnowledgeService } from "../lib/rag/knowledge-service.js";
import { BedrockDirectProvider } from "../lib/ai/providers/bedrock-direct-provider.js";
import { prisma } from "../lib/prisma.js";
// Epic #176 / #179 — publish an analysis finding via the shared scanner publisher.
import { publishAnalysisFinding } from "../lib/scanner/prisma-adapter.js";
import { PublishError } from "../lib/scanner/finding-publisher.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

// ── Clarify CSV import (Business Analyst round-trip) ───────────────────────
// Reuse the documents.ts memory-storage pattern: a single in-memory file capped
// at MAX_DOCUMENT_BYTES so the bytes never touch disk before validation. Row +
// cell bounds further cap parser memory (DoS guard).
const MAX_IMPORT_ROWS = 5000;
const MAX_CELL_CHARS = 10000;
const clarifyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
});

/**
 * Wrap `multer.single` so a Multer error (notably `LIMIT_FILE_SIZE`) surfaces as
 * a 400 AppError instead of the global handler's generic 500. Mirrors the
 * documents upload contract while keeping the size cap an explicit 400.
 */
function clarifyFileMiddleware(req: Request, res: Response, next: NextFunction): void {
  clarifyUpload.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const code = err.code === "LIMIT_FILE_SIZE" ? "FILE_TOO_LARGE" : "UPLOAD_ERROR";
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "Uploaded CSV exceeds the maximum allowed size"
          : `Upload failed: ${err.message}`;
      next(new AppError(400, code, message));
      return;
    }
    next(err);
  });
}

function actorFromReq(req: Request) {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

async function ensureProjectVisible(projectId: string): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });
  if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
}

/**
 * Resolve an analysis, enforcing analysis↔project ownership (OWASP A01 / BOLA).
 *
 * `projectId` is REQUIRED — deliberately so. Issue #1097 was a silent hole of
 * exactly this shape: `GET /:id/approvals` called `ensureAnalysisVisible(id)`
 * with the argument simply omitted, so a caller who legitimately passed the
 * router's `requireProjectAccess` guard for their OWN project could read another
 * project's analysis. The router-level guard cannot catch that (it authorizes
 * the project named in the PATH, not the resource resolved inside the handler),
 * and neither can the `project-access-guard` ratchet test, because this router
 * IS guarded. Making the parameter mandatory turns the next omission into a
 * COMPILE error instead of a silent authorization gap.
 *
 * @param projectId the path project the analysis must belong to. Pass `null`
 *   ONLY from {@link ensureAnalysisAccessible}, which serves the top-level
 *   `/api/analyses/:id` surface (no project in its path) and supplies the
 *   equivalent scope from the resolved row instead. Since #1099 that helper is
 *   the sole `null` caller — an explicit, greppable, *authorized* opt-out.
 */
async function ensureAnalysisVisible(analysisId: string, projectId: string | null) {
  // The scoped query returns null on mismatch → the same ANALYSIS_NOT_FOUND 404
  // an unknown id produces, so denials never act as an existence oracle.
  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, deletedAt: null, ...(projectId ? { projectId } : {}) },
  });
  if (!analysis) throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found");
  return analysis;
}

/**
 * Issue #1099 — object-level project scope for the top-level `/api/analyses`
 * router (OWASP A01 / BOLA).
 *
 * That router is mounted at `/api/analyses` with no `:projectId` segment, so the
 * `requireProjectAccess()` chokepoint (#674) cannot gate it and
 * `ensureAnalysisVisible`'s project predicate has nothing to bind to. Every
 * route on it was therefore gated by `requireAuth` plus a GLOBAL-role
 * `requirePermission(...)` alone: `analysis.read` is held by `reader`, the
 * lowest role, so ANY authenticated account could fetch the full snapshot —
 * findings and requirements — of ANY analysis in the deployment by id, and any
 * `developer` could cancel / regenerate / resume / edit another tenant's run.
 *
 * The fix is the resolve-then-authorize shape `run-authz.ts` (#1056) and
 * `connection-authz.ts` (#1055) established for routers that address a resource
 * by bare primary key: resolve the row, then hand its OWN `projectId` to the
 * canonical `assertProjectAccess` seam (`lib/custom-agents/authz.ts`), which
 * carries the three conventions the rest of the surface upholds — system-admin
 * bypass, pre-migration `workspaceId: null` projects open to any authenticated
 * caller, and 404-not-403.
 *
 * The seam's own 404 is re-labelled to `ANALYSIS_NOT_FOUND` so an out-of-tenant
 * id produces a byte-identical response to an unknown one — the route must not
 * become an existence oracle for analysis ids.
 */
async function ensureAnalysisAccessible(req: Request, analysisId: string) {
  const analysis = await ensureAnalysisVisible(analysisId, null);
  try {
    // `req.user!`: every caller sits behind `requireAuth` + `requirePermission`,
    // both of which 401 on a missing user before the handler runs. Same
    // narrowing convention as `routes/plugins.ts` and `routes/projects.ts`.
    await assertProjectAccess(req.user!, analysis.projectId);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found");
    }
    throw err;
  }
  return analysis;
}

interface InitOptions {
  /** Inject an orchestrator (tests). */
  orchestrator?: AnalysisOrchestrator;
}

export function initAnalysisRouter(opts: InitOptions = {}): {
  projectScoped: Router;
  topLevel: Router;
} {
  if (opts.orchestrator) setOrchestratorForTests(opts.orchestrator);

  const ensureOrch = (): AnalysisOrchestrator => {
    try {
      return getOrchestrator();
    } catch {
      // Lazy boot for production: build the appropriate provider.
      const config = loadAIConfig();
      let provider;
      if (
        (config.provider === "bedrock-gateway" || config.provider === "local-gemma") &&
        config.sdkProvider
      ) {
        // Use direct HTTP calls for analysis (no SDK session wrapping).
        provider = new BedrockDirectProvider({
          baseUrl: config.sdkProvider.baseUrl,
          apiKey: config.sdkProvider.apiKey ?? "",
          model: config.model,
          providerKey: config.provider,
          modelProfileMap: config.modelProfileMap,
        });
      } else {
        provider = buildProvider({ config });
      }
      const deps: OrchestratorDeps = { provider };
      const orch = new AnalysisOrchestrator(deps);
      setOrchestratorForTests(orch);
      return orch;
    }
  };

  // Project-scoped routes mounted under /api/projects/:projectId
  const projectScoped = Router({ mergeParams: true });
  // Epic #671 / #674 — object-level project scope (OWASP A01 / BOLA). Analyses,
  // clarify dialogs, approvals and finding deep-dive/publish are all addressed
  // under `/projects/:projectId/analyses`; gate the whole project-scoped subtree
  // on the caller's workspace membership before any handler runs. The existing
  // analysis↔project ownership checks (`ensureAnalysisVisible`) remain on top.
  projectScoped.use(requireAuth, requireProjectAccess());

  projectScoped.get(
    "/",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      await ensureProjectVisible(projectId);
      const items = await listAnalysesForProject(projectId);
      res.json(ok({ items }));
    },
  );

  // Issue #733 — pre-run capability probe. Returns the project-level facts the
  // start-analysis form needs to warn the operator (before a run) which
  // capabilities the run will/won't have. Read-only; requires analysis.read.
  projectScoped.get(
    "/capability",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      await ensureProjectVisible(projectId);
      res.json(ok(await detectStaticCapability(projectId)));
    },
  );

  projectScoped.post(
    "/",
    requireAuth,
    requirePermission("analysis.run"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      await ensureProjectVisible(projectId);
      const parsed = startAnalysisSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid analysis payload", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      try {
        const result = await ensureOrch().start({
          projectId,
          startedById: actor.id,
          agentKeys: parsed.data.agentKeys,
          documentIds: parsed.data.documentIds,
          model: parsed.data.model,
          extraInstructions: parsed.data.extraInstructions,
          enableWebResearch: parsed.data.enableWebResearch ?? false,
          enableClarification: parsed.data.enableClarification ?? false,
        });
        res.status(202).json(ok({ id: result.id }));
      } catch (err) {
        if (err instanceof CostCapExceededError) {
          throw new AppError(429, err.code, err.message, { cap: err.cap, used: err.used });
        }
        if (err instanceof Error && /not found/i.test(err.message)) {
          throw new AppError(404, "PROJECT_NOT_FOUND", err.message);
        }
        if (err instanceof Error && /archived/i.test(err.message)) {
          throw new AppError(409, "PROJECT_ARCHIVED", err.message);
        }
        throw err;
      }
    },
  );

  // Top-level routes mounted at /api/analyses
  const topLevel = Router();

  topLevel.get("/personas", requireAuth, (_req, res) => {
    res.json(ok({ items: getAllPersonas() }));
  });

  topLevel.get("/cost-cap", requireAuth, requirePermission("analysis.read"), async (_req, res) => {
    res.json(ok(await getCostCapStatus()));
  });

  topLevel.get(
    "/:id",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const id = String(req.params.id);
      // #1099 — no path project here; authorize against the analysis's own.
      await ensureAnalysisAccessible(req, id);
      const snapshot = await getAnalysisSnapshot(id);
      // Still reachable if the run is soft-deleted between the two queries.
      if (!snapshot) throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      res.json(ok(snapshot));
    },
  );

  topLevel.post(
    "/:id/cancel",
    requireAuth,
    requirePermission("analysis.run"),
    async (req: Request, res: Response) => {
      const id = String(req.params.id);
      // #1099 — no path project here; authorize against the analysis's own.
      await ensureAnalysisAccessible(req, id);
      const actor = actorFromReq(req);
      const cancelled = await ensureOrch().cancel(id, actor.id);
      res.json(ok({ cancelled }));
    },
  );

  topLevel.post(
    "/:id/agents/:agentKey/regenerate",
    requireAuth,
    requirePermission("analysis.run"),
    async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const rawAgent = String(req.params.agentKey);
      if (!(ANALYSIS_SPECIALIST_AGENT_KEYS as readonly string[]).includes(rawAgent)) {
        throw new AppError(400, "INVALID_AGENT_KEY", "Unknown specialist agent");
      }
      // #1099 — no path project here; authorize against the analysis's own.
      await ensureAnalysisAccessible(req, id);
      const orch = ensureOrch();
      try {
        // Synchronous pre-flight: cap, project state, regeneratable status.
        // The long-running pipeline is voided below; without this, those
        // errors would silently disappear into the unhandled rejection sink.
        await orch.assertCanRegenerate(id);
      } catch (err) {
        if (err instanceof CostCapExceededError) {
          throw new AppError(429, err.code, err.message, { cap: err.cap, used: err.used });
        }
        if (err instanceof AnalysisNotRegeneratableError) {
          throw new AppError(409, err.code, err.message, { currentStatus: err.currentStatus });
        }
        if (err instanceof Error && /not found/i.test(err.message)) {
          throw new AppError(404, "ANALYSIS_NOT_FOUND", err.message);
        }
        if (err instanceof Error && /archived/i.test(err.message)) {
          throw new AppError(409, "PROJECT_ARCHIVED", err.message);
        }
        throw err;
      }
      const actor = actorFromReq(req);
      void orch
        .regenerateAgent({
          analysisId: id,
          agentKey: rawAgent as AnalysisSpecialistAgentKey,
          actorId: actor.id,
        })
        .catch(() => {
          /* errors are persisted on the analysis row + audited */
        });
      res.status(202).json(ok({ accepted: true }));
    },
  );

  // Issue #741 (Epic #727) — re-run the agentic code agent for ONLY the repos a
  // prior multi-repo run dropped for token budget, merging their findings into
  // this analysis. Authorized identically to the sibling analysis mutations
  // (regenerate/cancel): `analysis.run` + `ensureAnalysisVisible`. Idempotent —
  // a 200 no-op when nothing is skipped; a synchronous 409 when the analysis is
  // still running (double-resume guard) or in a non-terminal state.
  topLevel.post(
    "/:id/resume-repos",
    requireAuth,
    requirePermission("analysis.run"),
    async (req: Request, res: Response) => {
      const id = String(req.params.id);
      // #1099 — no path project here; authorize against the analysis's own.
      await ensureAnalysisAccessible(req, id);
      const orch = ensureOrch();
      let skippedRepos;
      try {
        // Synchronous pre-flight: cap, project state, terminal status, and the
        // persisted skipped list — surfaced here so 429/409/404 don't vanish
        // into the voided background promise.
        ({ skippedRepos } = await orch.assertCanResumeRepos(id));
      } catch (err) {
        if (err instanceof CostCapExceededError) {
          throw new AppError(429, err.code, err.message, { cap: err.cap, used: err.used });
        }
        if (err instanceof AnalysisNotRegeneratableError) {
          throw new AppError(409, err.code, err.message, { currentStatus: err.currentStatus });
        }
        if (err instanceof Error && /not found/i.test(err.message)) {
          throw new AppError(404, "ANALYSIS_NOT_FOUND", err.message);
        }
        if (err instanceof Error && /archived/i.test(err.message)) {
          throw new AppError(409, "PROJECT_ARCHIVED", err.message);
        }
        throw err;
      }
      // Nothing was skipped — safe, idempotent no-op (never kicks off a run).
      if (skippedRepos.length === 0) {
        res.json(ok({ accepted: false, resumed: [], remaining: [] }));
        return;
      }
      const actor = actorFromReq(req);
      void orch.resumeSkippedRepos({ analysisId: id, actorId: actor.id }).catch(() => {
        /* errors are persisted on the analysis row + audited */
      });
      res.status(202).json(ok({ accepted: true, willResume: skippedRepos }));
    },
  );

  topLevel.patch(
    "/:id/requirements/:reqId",
    requireAuth,
    requirePermission("analysis.run"),
    async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const reqId = String(req.params.reqId);
      // #1099 — no path project here; authorize against the analysis's own.
      await ensureAnalysisAccessible(req, id);
      const parsed = updateRequirementSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid requirement patch", {
          issues: parsed.error.flatten(),
        });
      }
      const updated = await updateRequirementRow({
        analysisId: id,
        requirementId: reqId,
        patch: parsed.data,
      });
      if (!updated) {
        // 404 covers both "requirement does not exist" and "requirement
        // belongs to a different analysis" — never leak the difference.
        throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
      }
      const actor = actorFromReq(req);
      audit({
        actor: { id: actor.id },
        action: "analysis.requirement.update",
        target: { type: "requirement", id: reqId },
        metadata: { analysisId: id, fields: Object.keys(parsed.data) },
      });
      res.json(ok({ id: reqId }));
    },
  );

  // ── Epic #597 — Clarification Dialog endpoints ────────────────────────

  /**
   * GET /api/projects/:projectId/analyses/:id/clarify
   * Epic #201 (#213) — return the durable clarification dialog state so the UI
   * can rehydrate an in-flight dialog after a reload/restart. Returns
   * `{ state: null }` when no dialog has been started.
   *
   * Scoped with `ensureAnalysisVisible(id, projectId)` (#1097) — the dialog
   * state carries requirement text and grounded answers, so an unscoped lookup
   * here leaked another project's content.
   */
  projectScoped.get(
    "/:id/clarify",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);
      const state = await getDialogState(analysisId);
      res.json(ok({ state: state ?? null }));
    },
  );

  /**
   * POST /api/projects/:projectId/analyses/:id/clarify
   * Start or continue a clarification dialog round.
   */
  projectScoped.post(
    "/:id/clarify",
    requireAuth,
    requirePermission("analysis.run"),
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      // IDOR defence: assert the analysis belongs to the path project. Since
      // projectId now scopes knowledge-grounding retrieval below, this
      // relationship is load-bearing — protects both the start and
      // submit-answers branches.
      await ensureAnalysisVisible(analysisId, projectId);

      const body = req.body as
        | {
            requirements?: {
              requirements: unknown[];
              totalAmbiguities: number;
              totalEvidenceNeeds: number;
            };
            answers?: Array<{ questionId: string; answer: string }>;
          }
        | undefined;

      const config = loadAIConfig();
      const provider = buildProvider({ config });
      // Self-resolution (clarify-self-resolve): give the dialog a retriever +
      // projectId so it can ground each clarifying question against the
      // project's ingested knowledge before asking. Grounding only runs on the
      // START branch; submitAnswers is unaffected.
      const dialog = new ClarificationDialog({
        provider,
        retriever: getKnowledgeService(),
        projectId,
      });

      // Epic #922 — prefer the server-sourced structured requirements that the
      // enhancement pipeline persisted (#924). The client may still override by
      // passing `requirements` in the body, but it no longer has to reconstruct
      // them. Falls back to the request body when nothing was persisted.
      const requirements =
        (body?.requirements as StructuredRequirements | undefined) ??
        (await getStructuredRequirements(analysisId)) ??
        undefined;

      if (body?.answers && body.answers.length > 0) {
        // Submitting answers for the current round
        const state = await getDialogState(analysisId);
        if (!state) {
          throw new AppError(404, "NO_DIALOG", "No active clarification dialog for this analysis");
        }
        if (!requirements) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "requirements field is required to submit clarification answers",
          );
        }
        const result = await dialog.submitAnswers(analysisId, body.answers, requirements);
        // Epic #201 (#211) — close the feedback loop: persist the refined
        // requirements via the existing enhancement path so they reach
        // `Analysis.metadata` and flow downstream into synthesis (#212).
        // Idempotent per round: re-submitting overwrites the same metadata key.
        await persistAnalysisEnhancement(analysisId, {
          structuredRequirements: result.updatedRequirements,
        });
        // Issue #1116 — and into the ARTIFACT path. `structuredRequirements` is
        // only what the approval view renders; the drafts (and the GitHub issues
        // they become) are built from the `Requirement` rows, which replay the
        // synthesis output produced BEFORE any question was asked. When the
        // approval gate is still withholding those rows this is a no-op and
        // `promoteApprovedRequirements` applies the answers instead.
        await applyClarificationsToRequirements(analysisId);
        res.json(ok(result));
      } else {
        // Start or continue dialog
        if (!requirements) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "requirements field is required to start clarification",
          );
        }
        const state = await dialog.startOrContinue(analysisId, requirements);
        res.json(ok(state));
      }
    },
  );

  /**
   * GET /api/projects/:projectId/analyses/:id/clarify/export
   * Export the current round's clarifying questions as a round-trippable CSV
   * (or JSON via `?format=json`) so a Business Analyst can answer offline. The
   * CSV is injection-safe (formula-neutralized + RFC-4180 quoted via the shared
   * requirements CSV helpers). Columns:
   *   questionId,requirement,ambiguityField,question,suggestedAnswer,answer
   */
  projectScoped.get(
    "/:id/clarify/export",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);

      const state = await getDialogState(analysisId);
      const questions = state?.rounds.at(-1)?.questions ?? [];
      if (!state || questions.length === 0) {
        throw new AppError(
          409,
          "NO_DIALOG_QUESTIONS",
          "No clarifying questions are available to export. Start a clarification dialog first.",
        );
      }

      // Map requirementId → human title for the `requirement` column; fall back
      // to the raw id when the structured requirements are unavailable.
      const structured = await getStructuredRequirements(analysisId);
      const titleById = new Map<string, string>();
      for (const r of structured?.requirements ?? []) {
        titleById.set(r.id, r.title);
      }

      const rows: ClarifyExportRow[] = questions.map((q) => ({
        questionId: q.id,
        requirement: titleById.get(q.requirementId) ?? q.requirementId,
        ambiguityField: q.ambiguityField,
        question: q.question,
        suggestedAnswer: q.groundedAnswer ?? "",
        // Issue #1104 (finding C) — an already-answered round exports WITH its
        // answers, so a re-export is a review of the user's own work rather
        // than a blank form that silently discards it.
        answer: q.answer ?? "",
      }));

      if (req.query.format === "json") {
        res.json(ok({ rows: serializeClarifyJson(rows) }));
        return;
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="clarifying-questions-${analysisId}.csv"`,
      );
      res.send(serializeClarifyCsv(rows));
    },
  );

  /**
   * GET /api/projects/:projectId/analyses/:id/traceability
   *
   * Issue #737 (Epic #726) — the requirement→findings→code→tests traceability
   * matrix, assembled from already-persisted analysis data. Default response is
   * the JSON matrix; `?format=csv` / `?format=md` stream a downloadable export
   * (injection-safe CSV / GitHub-flavoured markdown) built from the same rows.
   *
   * Authorized identically to the other analysis reads: `analysis.read` +
   * `requireProjectAccess` (subtree) + `ensureAnalysisVisible(id, projectId)`
   * for analysis↔project ownership (OWASP A01 / BOLA — no cross-project leak).
   */
  projectScoped.get(
    "/:id/traceability",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);

      const matrix = await getTraceabilityMatrix(analysisId);
      if (!matrix) throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found");

      const format = typeof req.query.format === "string" ? req.query.format : "";
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="traceability-matrix-${analysisId}.csv"`,
        );
        res.send(serializeTraceabilityCsv(matrix));
        return;
      }
      if (format === "md" || format === "markdown") {
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="traceability-matrix-${analysisId}.md"`,
        );
        res.send(serializeTraceabilityMarkdown(matrix));
        return;
      }
      res.json(ok(matrix));
    },
  );

  /**
   * GET /api/projects/:projectId/analyses/:id/gap-report
   *
   * Issue #742 (Epic #728) — the per-requirement gap report (cited
   * current-implementation evidence → gap findings → effort estimate), assembled
   * from already-persisted analysis data. No LLM call and no recompute: effort
   * reuses the requirement's existing `storyPoints`.
   *
   * Authorized identically to the other analysis reads: `analysis.read` +
   * `requireProjectAccess` (subtree) + `ensureAnalysisVisible(id, projectId)` for
   * analysis↔project ownership (OWASP A01 / BOLA — no cross-project leak).
   */
  projectScoped.get(
    "/:id/gap-report",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);

      // #847 — supply the real `loadSchemaImpact` producer. #856 — the gate is now
      // the per-project database-aware resolver decision (#854), the SAME one the
      // run path (#855) reads, so the two can no longer diverge.
      const report = await getGapReport(analysisId, await resolveGapReportDeps(projectId));
      if (!report) throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      res.json(ok(report));
    },
  );

  /**
   * GET /api/projects/:projectId/analyses/:id/export?format=md
   *
   * Issue #744 (Epic #728) — the combined analyst "analysis report" markdown:
   * the #742 gap report (coverage summary + per-requirement current-impl
   * citations + gap findings) stitched together with the #737 traceability
   * matrix table (reusing #737's serializer verbatim). Assembled from
   * already-persisted data — no LLM call — and streamed as a downloadable
   * attachment (NOT the `{ success, data }` envelope), mirroring the #737 matrix
   * export. `format` currently accepts only `md` (the requirement/finding CSV
   * export is owned by #737's `/traceability?format=csv`).
   *
   * Authorized identically to the other analysis reads: `analysis.read` +
   * `requireProjectAccess` (subtree) + `ensureAnalysisVisible(id, projectId)` for
   * analysis↔project ownership (OWASP A01 / BOLA — no cross-project leak).
   */
  projectScoped.get(
    "/:id/export",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);

      // #847 — same producer on the export path so the downloaded report's
      // `databaseChanges` matches the /gap-report response (gated identically).
      // #856 — same resolver-driven gate as the /gap-report route above.
      const [gapReport, matrix] = await Promise.all([
        getGapReport(analysisId, await resolveGapReportDeps(projectId)),
        getTraceabilityMatrix(analysisId),
      ]);
      if (!gapReport || !matrix) {
        throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      }

      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="analysis-report-${analysisId}.md"`,
      );
      res.send(serializeAnalysisReportMarkdown({ gapReport, matrix }));
    },
  );

  /**
   * GET /api/projects/:projectId/analyses/:id/requirement-diff?base=<analysisId>
   *
   * Issue #743 (Epic #728) — the diff-style current-vs-proposed view for the
   * requirements that CHANGED between a base ("current") and this head
   * ("proposed") run. Composes the Change Analysis engine's requirement diffing
   * (its exported `matchRequirements` + scorers, via the pure aggregator) with the
   * #742 gap reports for the code-grounded evidence — no engine modifications and
   * no recompute of requirement text. `?base` defaults to the project's previous
   * completed run; with no base to compare, an explicit empty diff is returned.
   *
   * Authorized identically to the other analysis reads: `analysis.read` +
   * `requireProjectAccess` (subtree) + `ensureAnalysisVisible` for BOTH the head
   * and (when supplied) the base analysis, so neither can point at another
   * project's run (OWASP A01 / BOLA — no cross-project leak).
   */
  projectScoped.get(
    "/:id/requirement-diff",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);

      const baseParam = typeof req.query.base === "string" ? req.query.base : null;
      if (baseParam) {
        // Enforce base↔project ownership with the SAME IDOR guard as the head.
        await ensureAnalysisVisible(baseParam, projectId);
      }

      const diff = await getRequirementDiff({
        projectId,
        headAnalysisId: analysisId,
        baseAnalysisId: baseParam,
      });
      if (!diff) throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      res.json(ok(diff));
    },
  );

  /**
   * POST /api/projects/:projectId/analyses/:id/clarify/import
   * Consume a filled CSV, match answers to the current round by `questionId`,
   * and apply them through the EXISTING submit path (`submitAnswers` +
   * `persistAnalysisEnhancement`). Returns `{ applied, skipped, unmatched }`.
   */
  projectScoped.post(
    "/:id/clarify/import",
    requireAuth,
    requirePermission("analysis.run"),
    clarifyFileMiddleware,
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        throw new AppError(400, "FILE_REQUIRED", "Multipart field 'file' is required");
      }
      const isCsv =
        /\.csv$/i.test(file.originalname) ||
        file.mimetype === "text/csv" ||
        file.mimetype === "application/csv";
      if (!isCsv) {
        throw new AppError(400, "VALIDATION_ERROR", "Uploaded file must be a .csv");
      }

      let parsed;
      try {
        parsed = parseClarifyCsv(file.buffer.toString("utf-8"), {
          maxRows: MAX_IMPORT_ROWS,
          maxCellChars: MAX_CELL_CHARS,
        });
      } catch (err) {
        if (err instanceof ClarifyCsvError) {
          throw new AppError(400, "VALIDATION_ERROR", err.message);
        }
        throw err;
      }

      const state = await getDialogState(analysisId);
      if (!state) {
        throw new AppError(404, "NO_DIALOG", "No active clarification dialog for this analysis");
      }
      const questions = state.rounds.at(-1)?.questions ?? [];
      const validIds = new Set(questions.map((q) => q.id));

      const unmatched: string[] = [];
      // Dedupe matched answers by questionId (last filled value wins). The
      // parser has already dropped blank-answer rows.
      const appliedById = new Map<string, string>();
      for (const row of parsed.rows) {
        if (!validIds.has(row.questionId)) {
          unmatched.push(row.questionId);
          continue;
        }
        appliedById.set(row.questionId, row.answer);
      }
      // "skipped" = clarifying questions in this round that received no matched,
      // non-blank answer (left blank in the CSV or omitted entirely).
      const skipped = questions.filter((q) => !appliedById.has(q.id)).length;

      const applied = [...appliedById.entries()].map(([questionId, answer]) => ({
        questionId,
        answer,
      }));

      if (applied.length > 0) {
        const requirements = (await getStructuredRequirements(analysisId)) ?? undefined;
        if (!requirements) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "requirements field is required to submit clarification answers",
          );
        }
        const config = loadAIConfig();
        const provider = buildProvider({ config });
        const dialog = new ClarificationDialog({
          provider,
          retriever: getKnowledgeService(),
          projectId,
        });
        const result = await dialog.submitAnswers(analysisId, applied, requirements);
        await persistAnalysisEnhancement(analysisId, {
          structuredRequirements: result.updatedRequirements,
        });
        // Issue #1116 — the CSV round-trip is the same submit path, so it must
        // reach the artifact the same way.
        await applyClarificationsToRequirements(analysisId);
      }

      res.json(ok({ applied: applied.length, skipped, unmatched }));
    },
  );

  // ── Epic #597 — Approval Checkpoint endpoints ─────────────────────────

  /**
   * GET /api/projects/:projectId/analyses/:id/approvals
   * List approval requests for an analysis.
   *
   * Issue #1097 — this route resolved the analysis by BARE id, so it answered
   * 200 with `ticketStatus.allowed` computed for an analysis outside the
   * requested project (an authorization assertion for the wrong tenant). Scoped
   * with `ensureAnalysisVisible(id, projectId)` like every sibling route.
   */
  projectScoped.get(
    "/:id/approvals",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);
      const status = req.query.status as string | undefined;
      const validStatuses = new Set(["pending", "approved", "rejected"]);
      const statusFilter =
        status && validStatuses.has(status)
          ? (status as "pending" | "approved" | "rejected")
          : undefined;
      const items = await listApprovalRequests(analysisId, statusFilter);
      const ticketStatus = await canCreateTickets(analysisId);
      res.json(ok({ items, ticketStatus }));
    },
  );

  /**
   * PUT /api/projects/:projectId/analyses/:id/approvals/:approvalId
   * Approve or reject an approval request.
   *
   * Issue #1097 — same missing predicate as the sibling GET, but on a WRITE:
   * a caller could approve/reject another project's checkpoint. Both ids are now
   * bound to their parent: `ensureAnalysisVisible(id, projectId)` ties the
   * analysis to the path project, and `reviewApprovalRequest(analysisId, ...)`
   * ties the nested `:approvalId` to that analysis (scoped `findFirst`).
   */
  projectScoped.put(
    "/:id/approvals/:approvalId",
    requireAuth,
    requirePermission("analysis.run"),
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      const approvalId = String(req.params.approvalId);
      await ensureAnalysisVisible(analysisId, projectId);

      const body = req.body as { status?: string; reviewNote?: string } | undefined;
      if (!body?.status || !["approved", "rejected"].includes(body.status)) {
        throw new AppError(400, "VALIDATION_ERROR", "status must be 'approved' or 'rejected'");
      }

      const actor = actorFromReq(req);
      const updated = await reviewApprovalRequest(analysisId, approvalId, {
        status: body.status as "approved" | "rejected",
        reviewerId: actor.id,
        reviewNote: body.reviewNote,
      });

      audit({
        actor: { id: actor.id },
        action: "analysis.approval.review",
        target: { type: "approval_request", id: approvalId },
        metadata: { analysisId, status: body.status },
      });

      // Issue #1104 (finding B) — resolving the gate must actually RELEASE the
      // requirements it withheld. Without this the reviewer clears every
      // approval and the analysis still reads "No requirements yet" forever.
      // Idempotent + best-effort: a promotion failure never fails the review
      // that already succeeded, it is reported on the response instead.
      let promotion: PromotionOutcome;
      try {
        promotion = await promoteApprovedRequirements(analysisId);
      } catch {
        promotion = {
          status: "unavailable",
          reason: "Approval recorded, but promoting the requirements failed. Try again.",
        };
      }

      res.json(ok({ ...updated, promotion }));
    },
  );

  // ── Epic #176 / #178 — Finding deep-dive → issue draft ────────────────

  /**
   * POST /api/projects/:projectId/analyses/:id/findings/:findingId/deep-dive
   *
   * Expands a single analysis finding into a structured, publishable issue
   * draft via exactly one LLM call. Rate-limited (LLM-backed) and gated by the
   * monthly token cap. The finding is loaded scoped to its analysis + project
   * so a mismatched id returns 404 (IDOR defence).
   */
  projectScoped.post(
    "/:id/findings/:findingId/deep-dive",
    requireAuth,
    requirePermission("analysis.run"),
    analysisDeepDiveRateLimiter,
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      const analysisId = String(req.params.id);
      const findingId = String(req.params.findingId);

      const parsed = deepDiveFindingSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid deep-dive payload", {
          issues: parsed.error.flatten(),
        });
      }

      await ensureProjectVisible(projectId);
      // #1097 — scope the analysis to the path project too. The finding lookup
      // below already joins through Analysis → Project (so nothing leaked), but
      // an unscoped pre-check here is the exact shape of the defect this sweep
      // removes, and it reports the mismatch as ANALYSIS_NOT_FOUND like every
      // sibling route rather than as a missing finding.
      await ensureAnalysisVisible(analysisId, projectId);

      const finding = await loadFindingForDeepDive({ projectId, analysisId, findingId });
      if (!finding) {
        throw new AppError(404, "FINDING_NOT_FOUND", "Finding not found");
      }

      // Gate on the monthly token cap before spending an LLM call.
      try {
        await assertCanStartAnalysis();
      } catch (err) {
        if (err instanceof CostCapExceededError) {
          throw new AppError(429, err.code, err.message, { cap: err.cap, used: err.used });
        }
        throw err;
      }

      const actor = actorFromReq(req);
      const result = await deepDiveFinding(ensureOrch().provider, {
        projectName: finding.projectName,
        agentKey: finding.agentKey,
        finding: {
          title: finding.title,
          body: finding.body,
          category: finding.category,
          severity: finding.severity,
          citations: finding.citations,
          requirementId: finding.requirementId,
        },
        instructions: parsed.data.instructions,
      });

      audit({
        actor: { id: actor.id },
        action: "analysis.finding.deep_dive",
        target: { type: "finding", id: findingId },
        metadata: { analysisId, projectId, tokensUsed: result.usage.totalTokens },
      });

      res.json(
        ok({
          draft: result.draft,
          meta: { tokensUsed: result.usage.totalTokens, model: result.model },
        }),
      );
    },
  );

  /**
   * POST /api/projects/:projectId/analyses/:id/findings/:findingId/export?format=md|issue
   *
   * Issue #744 (Epic #728) — export a finding's (already-generated) deep-dive
   * draft as a GitHub issue draft. The client posts the draft it holds from the
   * deep-dive dialog (`findingIssueDraftSchema`); this route only SERIALIZES it —
   * no LLM call, no auto-create ("issue drafts", per the epic's out-of-scope). The
   * ACCEPTANCE CRITERIA render as a `- [ ]` checklist. All draft text is sanitized
   * server-side (HTML-neutralized, structure-safe) so the output is stable and
   * injection-free regardless of what the client submits.
   *
   *   - `format=md` (default) → `text/markdown` attachment (paste-ready doc).
   *   - `format=issue` → JSON `{ title, body, labels }` for `gh issue create`.
   *
   * Read-only (`analysis.read`): the payload is the caller's own content echoed
   * back, so there is no cross-tenant data surface beyond the analysis-visibility
   * guard. `requireProjectAccess` (subtree) + `ensureAnalysisVisible(id,
   * projectId)` enforce analysis↔project ownership (OWASP A01 / BOLA).
   */
  projectScoped.post(
    "/:id/findings/:findingId/export",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      const findingId = String(req.params.findingId);

      const parsed = findingIssueDraftSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid issue-draft payload", {
          issues: parsed.error.flatten(),
        });
      }

      await ensureAnalysisVisible(analysisId, projectId);

      const format = typeof req.query.format === "string" ? req.query.format : "";
      if (format === "issue") {
        res.json(ok(buildFindingIssueDraft(parsed.data)));
        return;
      }

      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="issue-draft-${findingId}.md"`);
      res.send(serializeFindingIssueDraftMarkdown(parsed.data));
    },
  );

  // ── Epic #176 / #179 — Publish finding → GitHub / Jira issue ──────────

  /**
   * POST /api/projects/:projectId/analyses/:id/findings/:findingId/publish
   *
   * Publishes an operator-edited issue draft for a finding to the project's
   * configured destination(s). Reuses the scanner finding-publisher (marker
   * dedup + idempotent IssueLink) — no parallel publishing path. The finding
   * is loaded scoped to its analysis + project (IDOR defence → 404).
   */
  projectScoped.post(
    "/:id/findings/:findingId/publish",
    requireAuth,
    requirePermission("issue.publish"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      const analysisId = String(req.params.id);
      const findingId = String(req.params.findingId);

      const parsed = publishFindingSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid publish payload", {
          issues: parsed.error.flatten(),
        });
      }

      await ensureProjectVisible(projectId);
      // #1097 — see the deep-dive route: scope the analysis pre-check to the
      // path project so this WRITE cannot even be addressed at a foreign run.
      await ensureAnalysisVisible(analysisId, projectId);

      const finding = await loadFindingForDeepDive({ projectId, analysisId, findingId });
      if (!finding) {
        throw new AppError(404, "FINDING_NOT_FOUND", "Finding not found");
      }

      // Resolve destination(s): explicit override wins, else the project's
      // configured publishDestination (github | jira | both).
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { publishDestination: true, jiraConnectionId: true, jiraProjectKey: true },
      });
      const providers: Array<"github" | "jira"> = parsed.data.provider
        ? [parsed.data.provider]
        : project?.publishDestination === "jira"
          ? ["jira"]
          : project?.publishDestination === "both"
            ? ["github", "jira"]
            : ["github"];

      // Jira destination requires a configured connection + project key.
      // Mirror the validation in projects.ts → 400, not a downstream 5xx.
      if (providers.includes("jira") && (!project?.jiraConnectionId || !project?.jiraProjectKey)) {
        throw new AppError(
          400,
          "JIRA_NOT_CONFIGURED",
          "Project has no Jira connection or project key configured — set one in project settings before publishing to Jira.",
        );
      }

      const actor = actorFromReq(req);
      try {
        const links: Array<{ provider: string; url: string; issueKey: string }> = [];
        for (const provider of providers) {
          const link = await publishAnalysisFinding({
            projectId,
            analysisId,
            findingId,
            agentKey: finding.agentKey,
            severity: finding.severity,
            category: finding.category,
            draft: parsed.data.draft,
            provider,
            extraLabels: parsed.data.extraLabels,
          });
          links.push({ provider, url: link.externalUrl, issueKey: link.externalId });
        }

        audit({
          actor: { id: actor.id },
          action: "analysis.finding.publish",
          target: { type: "finding", id: findingId },
          metadata: {
            analysisId,
            projectId,
            providers,
            links: links.map((l) => l.url),
          },
        });

        res.json(ok({ links }));
      } catch (err) {
        if (err instanceof PublishError) {
          const msg = err.message?.slice(0, 1000) ?? "publish failed";
          // Missing/incomplete destination config is a client-actionable 400
          // for the analysis publish flow (mirrors the Jira preflight above).
          if (err.code === "ERR_NOT_IMPLEMENTED") {
            throw new AppError(400, err.code, msg);
          }
          if (err.code === "ERR_STALE_COMMIT") {
            throw new AppError(409, err.code, msg);
          }
          throw new AppError(502, err.code || "PUBLISH_FAILED", msg);
        }
        throw err;
      }
    },
  );

  return { projectScoped, topLevel };
}
