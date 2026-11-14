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
import type { Prisma } from "@prisma/client";
import {
  type ApiResponse,
  ANALYSIS_SPECIALIST_AGENT_KEYS,
  specKitHandoffLabelsNotInContext,
  startAnalysisSchema,
  renameAnalysisSchema,
  regenerateAgentSchema,
  updateRequirementSchema,
  deepDiveFindingSchema,
  publishFindingSchema,
  findingIssueDraftSchema,
  type AnalysisSpecialistAgentKey,
  MAX_IMPORTED_REQUIREMENTS_PER_ANALYSIS,
  hasPermission,
  governingFindingDecisionInputSchema,
  governingRecheckInputSchema,
  editCheckpointRequirementSchema,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireRequirementWritePermission } from "../lib/requirements/requirement-write-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { optimisticLock, sendVersionConflict } from "../middleware/optimistic-lock.js";
// Issue #1099 — the top-level `/api/analyses` router has no path project to
// mount `requireProjectAccess` on; it authorizes through this seam instead.
import { assertLiveProjectAccess } from "../lib/custom-agents/authz.js";
import { analysisDeepDiveRateLimiter } from "../middleware/analysis-deepdive-rate-limit.js";
import {
  governingRecheckPreAuthRateLimiter,
  governingRecheckUserRateLimiter,
} from "../middleware/governing-recheck-rate-limit.js";
import {
  criteriaProposalPreAuthRateLimiter,
  criteriaProposalUserRateLimiter,
} from "../middleware/criteria-proposal-rate-limit.js";
import { dismissAllCriteriaProposals } from "../lib/analysis/analysis-service.js";
import { renameChangeRequest } from "../lib/analysis/change-request.js";
import {
  analysisRenamePreAuthRateLimiter,
  analysisRenameRateLimiter,
} from "../middleware/analysis-rename-rate-limit.js";
import {
  governingQuestionRequirementLabel,
  governingQuestionSourceFor,
} from "../lib/governing/applicability-questions.js";
import { readGoverningApplicability } from "../lib/governing/applicability-store.js";
import {
  decideGoverningFinding,
  governingFindingRevisions,
  governingFindingsRefreshing,
  listGoverningFindings,
  summariseFindings,
} from "../lib/governing/findings-store.js";
import { isGoverningDocsEnabled } from "../lib/governing/flag.js";
import { recheckGoverningRequirement } from "../lib/governing/recheck.js";
import {
  editedWithoutFindings,
  recheckedRequirementTitles,
  storedRequirementStates,
  withGoverningStaleness,
} from "../lib/governing/requirement-staleness.js";
import { requirementsWithoutCodeEvidence } from "../lib/analysis/code-evidence.js";
import { inSynthesisOrder } from "../lib/analysis/synthesis-finding-order.js";
import { createChildLogger } from "../lib/logger.js";
import {
  withheldReplacementPreAuthRateLimiter,
  withheldReplacementUserRateLimiter,
} from "../middleware/withheld-replacement-rate-limit.js";
import {
  WithheldReplacementError,
  applyWithheldReplacement,
  dismissWithheldReplacement,
  getWithheldReplacementDiff,
} from "../lib/analysis/withheld-replacement-service.js";
import { importedRequirementsRateLimiter } from "../middleware/imported-requirements-rate-limit.js";
import {
  analysisMatrixPreAuthRateLimiter,
  analysisMatrixUserRateLimiter,
} from "../middleware/analysis-matrix-rate-limit.js";
import {
  analysisApprovalEditRateLimiter,
  analysisApprovalPreAuthRateLimiter,
  analysisApprovalPromoteRateLimiter,
  analysisApprovalReopenRateLimiter,
  analysisApprovalReviewRateLimiter,
} from "../middleware/analysis-approval-rate-limit.js";
import {
  loadSourceGuard,
  restrictedIds,
  userSourceReader,
  type SourceReader,
} from "../lib/analysis/source-redaction.js";
import { AppError } from "../middleware/error-handler.js";
import { documentFile } from "../middleware/document-file-upload.js";
import {
  AnalysisOrchestrator,
  AnalysisNotRegeneratableError,
  CodeInvestigationContinueLimitError,
  CodeInvestigationContinueNotOfferedError,
  CostCapExceededError,
  assertCanStartAnalysis,
  type OrchestratorDeps,
  getAllPersonas,
  getAnalysisSnapshot,
  detectStaticCapability,
  getCostCapStatus,
  getOrchestrator,
  getStructuredRequirements,
  persistClarifiedRequirements,
  listAnalysesForProject,
  setOrchestratorForTests,
  updateRequirementRow,
  // Epic #597 — requirements enhancement pipeline.
  ClarificationDialog,
  getDialogState,
  listApprovalRequests,
  reopenApprovalRequest,
  approveAllPendingApprovalRequests,
  rejectPendingRequirementApprovals,
  reviewApprovalRequest,
  canCreateTickets,
  // Issue #1104 (finding B) — release the requirements the gate withheld.
  promoteApprovedRequirements,
  // Issue #1129 — the run's recorded #1063 provenance for the ticked/added split.
  readSynthesisOutput,
  // Issue #1568 — the findings synthesis's evidence indexes refer to.
  readFlattenedFindings,
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
  // #1137 — one requirement's database changes, fetched when the analyst opens them.
  getRequirementDatabaseChanges,
  // Issue #744 — markdown / GitHub-issue-draft export.
  buildFindingIssueDraft,
  serializeFindingIssueDraftMarkdown,
  serializeAnalysisReportMarkdown,
} from "../lib/analysis/index.js";
import { ModelNotServedError } from "../lib/ai/model-router.js";
import { RequirementVersionError } from "../lib/requirements/requirement-version-service.js";
import {
  flagSelfApprovalForbidden,
  selfApprovalFlagDue,
} from "../lib/requirements/project-requirements-list.js";
import { visibleRequirementLabels } from "../lib/analysis/requirement-labels.js";
import { listPromptOnlyAnalysisAgents } from "../lib/analysis/custom-agent-phase.js";
import {
  composeImportedRequirementInput,
  listImportedRequirements,
  loadSelectedImportedRequirements,
  normaliseImportedRequirementQuery,
} from "../lib/analysis/imported-requirement-input.js";
import { resolveNewRequirementCandidateCap } from "../lib/analysis/new-requirements.js";
// Issue #743 — diff-style current-vs-proposed view for changed requirements.
import { getRequirementDiff } from "../lib/change-analysis/requirement-diff-service.js";
// #1137 — the Traceability tab's per-requirement lists are paged.
import { parseListPageQuery, sliceListPage } from "../lib/analysis/list-page.js";
import {
  addressedAmbiguities,
  type ClarificationState,
  type StructuredRequirements,
} from "../lib/analysis/types/requirements.js";
import { clarifyRequestSchema } from "../lib/analysis/clarify-request-schema.js";
import { editCheckpointRequirement } from "../lib/analysis/checkpoint-requirement-edit.js";
import { meterAnalysisProvider, runInAnalysisUsageScope } from "../lib/analysis/analysis-usage.js";
// Issue #1116 — carry the submitted answers into the persisted requirement rows
// (and therefore into the drafts/issues they become), not just the metadata the
// approval view reads.
import { applyClarificationsToRequirements } from "../lib/analysis/clarification-enrichment.js";
import {
  persistClarificationKnowledge,
  priorAnswerSourceFor,
  rerunReusedClarifications,
} from "../lib/clarifications/analysis-clarifications.js";
import { readDialogState } from "../lib/analysis/clarification-dialog-store.js";
import { readSourceRequirements } from "../lib/analysis/source-items.js";
import { latestRequirementApprovals } from "../lib/analysis/approved-requirement-set.js";
import {
  classifyRequirementOrigins,
  tickedFirst,
  type RequirementOrigin,
} from "../lib/analysis/imported-scope.js";
import {
  serializeClarifyCsv,
  serializeClarifyJson,
  parseClarifyCsv,
  ClarifyCsvError,
  type ClarifyExportRow,
} from "../lib/analysis/clarify-csv.js";
import { audit } from "../lib/audit/audit-service.js";
import { dispatchReviewedRequirementEdited } from "../lib/reviews/notify.js";
import { buildProvider, loadAIConfig } from "../lib/ai/index.js";
import { getKnowledgeService } from "../lib/rag/knowledge-service.js";
import { sharedAudienceRetriever } from "../lib/analysis/document-access.js";
import { BedrockDirectProvider } from "../lib/ai/providers/bedrock-direct-provider.js";
import { prisma } from "../lib/prisma.js";
// Epic #176 / #179 — publish an analysis finding via the shared finding publisher.
import { publishAnalysisFinding } from "../lib/publishing/analysis-finding-publish.js";
import {
  CrossProjectRepoError,
  describeCrossProjectRefusal,
} from "../lib/publishing/cross-project-guard.js";
import { PublishError } from "../lib/publishing/finding-publisher.js";
import { noteProjectRequirementsChanged } from "../lib/docs-gen/approved-requirements-staleness.js";
import { signOffForRole } from "../lib/analysis/checkpoint-sign-off.js";
import { readChangeRequestReviewState } from "../lib/reviews/change-request-review-state.js";

/**
 * Promote an analysis's approved requirements (#1104) and, when rows were
 * written, ask the reader-BRD check to look again (#1230): the promoted set is
 * a run's requirements, and may move the run the Requirements hub opens on.
 *
 * #1588 — the caller's role decides how the rows land: `approved` with
 * `project.update`, `draft` without it (a developer approving the checkpoint of
 * the analysis they ran). Every checkpoint route that can promote calls this.
 */
async function promoteAndNote(
  analysisId: string,
  projectId: string,
  req: Request,
): Promise<PromotionOutcome> {
  const promotion = await promoteApprovedRequirements(
    analysisId,
    signOffForRole(req.user!.role, req.user!.userId),
  );
  if (promotion.status === "promoted") void noteProjectRequirementsChanged(projectId);
  return promotion;
}

/**
 * Issue #1602 — persist a clarify round onto the list as it is now. #1657 —
 * when the list was replaced by another extraction run meanwhile, nothing is
 * written, so the request is refused (409) rather than answered 200 with an
 * `updatedRequirements` that was never stored; the caller re-reads the new list.
 * #2142 — written in `tx`, the transaction that commits the round, so the
 * refusal rolls the round back with it.
 */
async function persistClarifiedRound(
  analysisId: string,
  before: StructuredRequirements & { runId?: string },
  result: {
    state: Parameters<typeof addressedAmbiguities>[0];
    updatedRequirements: StructuredRequirements;
  },
  tx: Prisma.TransactionClient,
): Promise<void> {
  const written = await persistClarifiedRequirements(
    analysisId,
    before,
    result.updatedRequirements,
    addressedAmbiguities(result.state),
    tx,
  );
  if (!written) {
    throw new AppError(
      409,
      "REQUIREMENTS_REPLACED",
      "The requirements were extracted again while your answers were being applied, so they were not saved. Reload the requirements and answer again.",
    );
  }
}

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

// ── Clarify CSV import (Business Analyst round-trip) ───────────────────────
// The file is read by `documentFile`, the multipart reader the document upload
// routes share (#1948): one in-memory file capped at MAX_DOCUMENT_BYTES, so the
// bytes never touch disk before validation, and the same 413 / 400 errors.
// Row + cell bounds further cap parser memory (DoS guard).
const MAX_IMPORT_ROWS = 5000;
const MAX_CELL_CHARS = 10000;

function actorFromReq(req: Request) {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

/**
 * #2447 — the reader every analysis read redacts for: the caller, whose role
 * is read from durable state only when a source they cite is restricted.
 */
function readerOf(req: Request): SourceReader {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return userSourceReader(req.user.userId);
}

/**
 * #2447 — a requirement of run `analysisId` whose sources the caller cannot
 * see answers 404, like an unknown one. An unknown one passes: the handler
 * gives its own 404.
 */
async function ensureRequirementSourcesVisible(
  req: Request,
  analysisId: string,
  requirementId: string,
): Promise<void> {
  const row = await prisma.requirement.findFirst({
    where: { id: requirementId, analysisId, deletedAt: null },
    select: { id: true, analysisId: true, sourceIds: true },
  });
  if (row && (await restrictedIds(readerOf(req), [row])).size > 0) {
    throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
  }
}

/**
 * #2447 — the reviewed-list entry a requirement approval of run `analysisId`
 * names, when the caller cannot see it, answers like an unknown approval
 * (404): an edit would send its text back and overwrite what they cannot read.
 * An entry promoted into a requirement is decided by that requirement's
 * sources; one not yet promoted rests on the run as a whole. An unknown
 * approval passes: the handler gives its own 404.
 */
async function ensureCheckpointEntryVisible(
  req: Request,
  analysisId: string,
  approvalId: string,
): Promise<void> {
  const approval = await prisma.approvalRequest.findFirst({
    where: { id: approvalId, analysisId },
    select: { itemId: true },
  });
  if (!approval) return;
  const promoted = await prisma.requirement.findFirst({
    where: { analysisId, promotedStructuredId: approval.itemId, deletedAt: null },
    select: { analysisId: true, sourceIds: true },
  });
  const guard = await loadSourceGuard(readerOf(req), [promoted ?? { analysisId, sourceIds: null }]);
  const visible = promoted ? guard.canSee(promoted) : guard.canSeeRun(analysisId);
  if (!visible) {
    throw new AppError(404, "APPROVAL_NOT_FOUND", `Approval request ${approvalId} not found`);
  }
}

/**
 * #2447 — whether the caller may see what rests on run `analysisId` as a whole
 * (its clarify dialog, its withheld re-synthesis): every document the run
 * read, as its access list is now (`canSeeRun`).
 */
async function seesRunAsWhole(req: Request, analysisId: string): Promise<boolean> {
  const guard = await loadSourceGuard(readerOf(req), [{ analysisId, sourceIds: null }]);
  return guard.canSeeRun(analysisId);
}

/** #2447 — the snapshot loader of a report the caller reads: redacted for them. */
function snapshotLoaderFor(req: Request): typeof getAnalysisSnapshot {
  const reader = readerOf(req);
  return (id) => getAnalysisSnapshot(id, { reader });
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
 * Issue #1129 — on a run started from ticked imported items, whether each
 * reviewed (structured) requirement restates a ticked item or was added by the
 * analysis. Empty for any other run. The approvals list, clarify ordering and
 * reject-added all read this one classification.
 */
async function requirementOriginsFor(
  analysisId: string,
  metadata: unknown,
): Promise<Map<string, RequirementOrigin>> {
  const sources = readSourceRequirements(metadata);
  if (sources.length === 0) return new Map();
  const [structured, synthesis, approvals] = await Promise.all([
    getStructuredRequirements(analysisId),
    readSynthesisOutput(analysisId),
    listApprovalRequests(analysisId),
  ]);
  // Promotion joins provenance over the approved subset, so a requirement whose
  // latest approval is rejected must not take part in the join here either.
  const latest = latestRequirementApprovals(
    (approvals ?? []).filter((a) => a.type === "requirement"),
  );
  const rejectedIds = new Set(
    [...latest.values()].filter((a) => a.status === "rejected").map((a) => a.itemId),
  );
  // #1063's recorded `sourceIds` decide first — the same provenance behind the
  // "Added by the analysis" badge; the word join covers only what has none.
  return classifyRequirementOrigins(
    structured?.requirements ?? [],
    sources,
    synthesis?.requirements ?? [],
    { rejectedIds },
  );
}

const log = createChildLogger("analysis-routes");

/**
 * Issue #1568 — the reviewed requirements approving would promote with no code
 * link: their synthesis item cites no finding that could become one. Empty
 * until synthesis has run (before it, no requirement has an item yet, and
 * saying "no code evidence" of all of them would be wrong) and for an analysis
 * with no reviewed list.
 */
async function requirementsWithoutCodeEvidenceFor(
  analysisId: string,
  listed: ReadonlyArray<{ type: string; itemId: string; status: string; createdAt: Date }>,
  filtered: boolean,
): Promise<Set<string>> {
  if (!listed.some((a) => a.type === "requirement")) return new Set();
  // Best-effort: the approvals list must not fail over an advisory mark.
  try {
    // Every approval, not the filtered page, so a rejection still counts.
    const approvals = filtered ? await listApprovalRequests(analysisId) : listed;
    const requirementApprovals = approvals.filter((a) => a.type === "requirement");
    const [structured, synthesis] = await Promise.all([
      getStructuredRequirements(analysisId),
      readSynthesisOutput(analysisId),
    ]);
    if (!structured || structured.requirements.length === 0 || !synthesis) return new Set();
    const rejectedIds = new Set(
      [...latestRequirementApprovals(requirementApprovals).values()]
        .filter((a) => a.status === "rejected")
        .map((a) => a.itemId),
    );
    return requirementsWithoutCodeEvidence({
      structured: structured.requirements,
      synthesized: synthesis.requirements,
      // As synthesis numbered them, and promotion reads them (#1603), so the
      // evidence indexes resolve to the findings synthesis cited.
      findings: inSynthesisOrder(await readFlattenedFindings(analysisId)),
      rejectedIds,
    });
  } catch (err) {
    log.warn("Could not work out which requirements have no code evidence", {
      analysisId,
      error: (err as Error).message,
    });
    return new Set();
  }
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
    await assertLiveProjectAccess(req.user!, analysis.projectId);
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

/**
 * #865 / #871 — the optimistic-lock view of an analysis-scoped requirement,
 * used by the lock middleware and again by the PATCH handler when the write
 * transaction itself detects a conflict.
 */
async function loadLockedAnalysisRequirement(req: Request) {
  const row = await prisma.requirement.findFirst({
    where: {
      id: String(req.params.reqId),
      analysisId: String(req.params.id),
      deletedAt: null,
    },
    select: {
      id: true,
      version: true,
      title: true,
      body: true,
      priority: true,
      type: true,
      labels: true,
      storyPoints: true,
      // #1612 — so a stale-version PATCH of kind reports its diff in the 409.
      kind: true,
      nfrCategory: true,
      reviewStatus: true,
    },
  });
  if (!row) return null;
  // The lock diffs against the request body, which carries labels as a
  // string[]; present the stored JSON column in that shape — and only the
  // labels the caller sees. The hidden `finding:*` / `review:*` labels are
  // preserved by the write, so they are never a conflict and never offered
  // as the "server" value in the merge modal.
  return { ...row, labels: visibleRequirementLabels(row.labels) };
}

/**
 * #1636 — the project's repo connector id → repo name for the analysis report
 * export, so a code citation stamped with its repo (#1611) names it (the page
 * shows the same name, read from the connector list). Read only for a caller
 * who may list the project's connectors (`connector.read`), as the page's read
 * of that list is gated; anyone else gets no names, and a stamped citation then
 * shows its connector id. Same name rule as the UI's `repoNamesById`.
 */
async function exportRepoNames(req: Request, projectId: string): Promise<Record<string, string>> {
  if (!req.user || !hasPermission(req.user.role, "connector.read")) return {};
  const rows = await prisma.repoConnection.findMany({
    where: { projectId },
    select: { id: true, label: true, repoName: true },
  });
  return Object.fromEntries(rows.map((r) => [r.id, r.repoName?.trim() || r.label || r.id]));
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
      // #938 — and the enabled agents the run will invoke prompt-only.
      const [preview, promptOnlyAgents] = await Promise.all([
        detectStaticCapability(projectId),
        listPromptOnlyAnalysisAgents(projectId),
      ]);
      res.json(ok({ ...preview, promptOnlyAgents }));
    },
  );

  // Issue #1006 — the project's imported requirements a run can start from,
  // and how many one run analyses individually.
  projectScoped.get(
    "/imported-requirements",
    // Per-IP (runs after the router-level auth): CodeQL js/missing-rate-limiting.
    importedRequirementsRateLimiter,
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      await ensureProjectVisible(projectId);
      const q = normaliseImportedRequirementQuery(req.query.q);
      res.json(
        ok({
          ...(await listImportedRequirements(projectId, q)),
          maxSelectable: Math.min(
            resolveNewRequirementCandidateCap(),
            MAX_IMPORTED_REQUIREMENTS_PER_ANALYSIS,
          ),
        }),
      );
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
      // #1027 — the handoff record's "sent as context" labels are shown on the
      // analysis page, so they must name text the code agent was really given.
      const unbacked = specKitHandoffLabelsNotInContext(
        parsed.data.specKitHandoff,
        parsed.data.agentContext,
      );
      if (unbacked.length > 0) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid analysis payload", {
          issues: {
            formErrors: [],
            fieldErrors: {
              specKitHandoff: [`${unbacked.length} context label(s) do not appear in agentContext`],
            },
          },
        });
      }
      // Issue #1006 — imported requirements lead the new-requirements text, one
      // `NR-*` each, and the run records which imported item each id was.
      let extraInstructions = parsed.data.extraInstructions;
      let sourceRequirements;
      const importedIds = parsed.data.importedRequirementIds;
      if (importedIds?.length) {
        const cap = resolveNewRequirementCandidateCap();
        if (new Set(importedIds).size > cap) {
          throw new AppError(
            400,
            "IMPORTED_REQUIREMENTS_OVER_CAP",
            `Select at most ${cap} imported requirements per analysis; each one is analysed individually.`,
            { cap },
          );
        }
        const selected = await loadSelectedImportedRequirements(projectId, importedIds);
        ({ extraInstructions, sourceRequirements } = composeImportedRequirementInput(
          selected,
          extraInstructions,
        ));
      }
      const actor = actorFromReq(req);
      try {
        const result = await ensureOrch().start({
          projectId,
          startedById: actor.id,
          // #2341 — the analyst's title; absent, `createAnalysis` stores the
          // default from the run's sources (the rule every start path shares).
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          ...(parsed.data.startedWithDefaults ? { startedWithDefaults: true } : {}),
          agentKeys: parsed.data.agentKeys,
          documentIds: parsed.data.documentIds,
          model: parsed.data.model,
          extraInstructions,
          ...(sourceRequirements ? { sourceRequirements } : {}),
          enableWebResearch: parsed.data.enableWebResearch ?? false,
          enableClarification: parsed.data.enableClarification ?? false,
          ...(parsed.data.rereadDocuments ? { rereadDocuments: true } : {}),
          ...(parsed.data.specKitHandoff ? { specKitHandoff: parsed.data.specKitHandoff } : {}),
          // #1027 — never joined to `extraInstructions`: the requirement
          // splitter, its cap and the input account do not see it.
          ...(parsed.data.agentContext ? { agentContext: parsed.data.agentContext } : {}),
        });
        res.status(202).json(ok({ id: result.id }));
      } catch (err) {
        if (err instanceof CostCapExceededError) {
          throw new AppError(429, err.code, err.message, { cap: err.cap, used: err.used });
        }
        // #978 — a forced Claude tier the provider cannot run: refused, not remapped.
        if (err instanceof ModelNotServedError) {
          throw new AppError(400, err.code, err.message, {
            requested: err.requested,
            configuredModel: err.configuredModel,
          });
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

  // Issue #2341 — rename a change request. `analysis.run` is the permission
  // that starts (and so names) one; a reader, who holds only `analysis.read`,
  // is refused 403. The project-access gate above runs first, and the update
  // is scoped on the project AND the id, so a run of another project is the
  // same 404 as an unknown one and its title is never read or written.
  projectScoped.patch(
    "/:id",
    // Per-IP ahead of auth (CodeQL js/missing-rate-limiting), then per user,
    // bounded like the sibling `PATCH …/approvals/:approvalId/requirement`.
    analysisRenamePreAuthRateLimiter,
    requireAuth,
    requirePermission("analysis.run"),
    analysisRenameRateLimiter,
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      const id = String(req.params.id);
      const parsed = renameAnalysisSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid change request title", {
          issues: parsed.error.flatten(),
        });
      }
      const renamed = await renameChangeRequest(projectId, id, parsed.data.title);
      if (!renamed) throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      const actor = actorFromReq(req);
      audit({
        actor: { id: actor.id },
        action: "analysis.rename",
        target: { type: "analysis", id },
        // The title itself is not audited: it is user text, and the row holds it.
        metadata: { projectId, titleLength: parsed.data.title.length },
      });
      res.json(ok({ id, title: parsed.data.title }));
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
      const snapshot = await getAnalysisSnapshot(id, { reader: readerOf(req) });
      // Still reachable if the run is soft-deleted between the two queries.
      if (!snapshot) throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      // #2462 — a requirement the caller wrote or edited says so when the
      // project does not allow self-approval, so the card explains Approve
      // before the click (as the Requirements list does, #2452). Not while the
      // page polls a run in progress: see `selfApprovalFlagDue`.
      const requirements = await flagSelfApprovalForbidden(
        snapshot.projectId,
        snapshot.requirements,
        req.user && selfApprovalFlagDue(snapshot)
          ? {
              userId: req.user.userId,
              canApprove: hasPermission(req.user.role, "requirement.approve"),
            }
          : undefined,
      );
      res.json(ok({ ...snapshot, requirements }));
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
      // #1001 — `extendBudget` continues a code investigation cut short by its budget.
      const parsed = regenerateAgentSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid regenerate payload", {
          issues: parsed.error.flatten(),
        });
      }
      const extendBudget = parsed.data.extendBudget === true;
      if (extendBudget && rawAgent !== "code") {
        throw new AppError(
          400,
          "EXTEND_BUDGET_CODE_ONLY",
          "Only the code agent can continue with a larger budget",
        );
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
      // #1062 — "Continue with a larger budget" is limited: every continuation
      // reruns at the same enlarged budget, so once it has been used another
      // one is refused here, with the reason, rather than accepted and repeated.
      if (extendBudget) {
        try {
          await orch.assertCanContinueInvestigation(id);
        } catch (err) {
          if (err instanceof CodeInvestigationContinueLimitError) {
            throw new AppError(409, err.code, err.message, { continuations: err.continuations });
          }
          // #1131 — nothing was left unreached, so a larger budget cannot help.
          if (err instanceof CodeInvestigationContinueNotOfferedError) {
            throw new AppError(409, err.code, err.message);
          }
          throw err;
        }
      }
      const actor = actorFromReq(req);
      void orch
        .regenerateAgent({
          analysisId: id,
          agentKey: rawAgent as AnalysisSpecialistAgentKey,
          actorId: actor.id,
          ...(extendBudget ? { extendBudget } : {}),
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
    // #1566 — an edit or a review verdict is a requirement write, the same as
    // `PUT /api/requirements/:id`, so it needs the same permissions.
    // `analysis.run` (which `developer` holds) let a developer edit, approve or
    // reject here what the PUT route refuses them. #2436 — as on the PUT: the
    // verdict needs `requirement.approve`, any other field `project.update`.
    requireRequirementWritePermission(),
    // #1099 — no path project here; authorize against the analysis's own.
    // Runs BEFORE the lock, whose 409 diff would otherwise describe a row the
    // caller cannot reach.
    async (req: Request, _res: Response, next: NextFunction) => {
      await ensureAnalysisAccessible(req, String(req.params.id));
      // #2447 — nor one whose sources the caller cannot see: the 409 diff and
      // the edit itself would both show its text.
      await ensureRequirementSourcesVisible(req, String(req.params.id), String(req.params.reqId));
      next();
    },
    // #865 — the optimistic-concurrency contract of `PUT /api/requirements/:id`:
    // a body `version` that is not the current one is a 409 with a field diff;
    // no `version` skips the check. The loader is scoped to this analysis, so a
    // requirement of another one is the same 404 the handler gives.
    optimisticLock("requirement", loadLockedAnalysisRequirement),
    async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const reqId = String(req.params.reqId);
      const parsed = updateRequirementSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid requirement patch", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = actorFromReq(req);
      // #871 — the lock middleware's read is outside the write transaction, so
      // two concurrent edits with the same version both pass it. The service
      // re-checks the version inside the transaction. (The shared schema strips
      // `version`; the middleware has already validated it is a number.)
      const bodyVersion = (req.body as Record<string, unknown> | undefined)?.version;
      const expectedVersion = typeof bodyVersion === "number" ? bodyVersion : undefined;
      let updated: Awaited<ReturnType<typeof updateRequirementRow>>;
      try {
        updated = await updateRequirementRow({
          analysisId: id,
          requirementId: reqId,
          patch: parsed.data,
          actorId: actor.id,
          expectedVersion,
        });
      } catch (err) {
        if (err instanceof RequirementVersionError && err.code === "SELF_APPROVAL_FORBIDDEN") {
          throw new AppError(403, "SELF_APPROVAL_FORBIDDEN", err.message);
        }
        if (
          err instanceof RequirementVersionError &&
          err.code === "VERSION_CONFLICT" &&
          expectedVersion !== undefined
        ) {
          const current = await loadLockedAnalysisRequirement(req);
          if (!current) throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
          sendVersionConflict(
            res,
            "requirement",
            current,
            req.body as Record<string, unknown>,
            expectedVersion,
          );
          return;
        }
        throw err;
      }
      if (!updated) {
        // 404 covers both "requirement does not exist" and "requirement
        // belongs to a different analysis" — never leak the difference.
        throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
      }
      audit({
        actor: { id: actor.id },
        action: "analysis.requirement.update",
        target: { type: "requirement", id: reqId },
        metadata: {
          analysisId: id,
          fields: Object.keys(parsed.data),
          // #1162 — the status is not versioned, so its from/to lives here.
          ...(updated.reviewStatusChange ? { reviewStatus: updated.reviewStatusChange } : {}),
          // #2436 — the author approved it, as the project's setting allows.
          ...(updated.selfApproved ? { selfApproval: true } : {}),
        },
      });
      // #2219 — post-commit: a review that pinned the replaced version is told.
      if (updated.changed) {
        dispatchReviewedRequirementEdited({
          requirementId: reqId,
          fromVersion: updated.version - 1,
          toVersion: updated.version,
          actorId: actor.id,
        });
      }
      // `version` is additive: the next optimistic-lock token for the caller.
      res.json(ok({ id: reqId, version: updated.version }));
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
  /**
   * GET /api/projects/:projectId/analyses/:id/review-state
   * #2343 — the change request's formal review as the caller sees it: the
   * latest standing review of its requirements (and whether the caller asked
   * for it), and a review of it waiting on the caller's own decision. Needs
   * `review.read` on top of `analysis.read`: it names reviews. Scoped with
   * `ensureAnalysisVisible`, and every read filters on the project and run.
   */
  projectScoped.get(
    "/:id/review-state",
    requireAuth,
    requirePermission("analysis.read"),
    requirePermission("review.read"),
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);
      const actor = actorFromReq(req);
      res.json(ok(await readChangeRequestReviewState(projectId, analysisId, actor.id)));
    },
  );

  projectScoped.get(
    "/:id/clarify",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);
      // #2447 — the dialog rests on the run as a whole: none, for a reader who
      // cannot see every document it read.
      if (!(await seesRunAsWhole(req, analysisId))) {
        res.json(ok({ state: null }));
        return;
      }
      const state = await getDialogState(analysisId);
      res.json(ok({ state: state ?? null }));
    },
  );

  /**
   * GET /api/projects/:projectId/analyses/:id/governing-applicability
   * #1873 — the analysis's stored governing-rule applicability (#1872): per
   * requirement, each candidate rule's verdict, and for a pair a BA answer
   * re-decided, how (`settled`). 404 while `GOVERNING_DOCS_ENABLED` is off, as
   * every governing route is; `{ applicability: null }` when none was decided.
   * Scoped with `ensureAnalysisVisible(id, projectId)` like its siblings.
   */
  projectScoped.get(
    "/:id/governing-applicability",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      if (!isGoverningDocsEnabled()) throw new AppError(404, "NOT_FOUND", "Not found");
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);
      res.json(ok({ applicability: await readGoverningApplicability(analysisId) }));
    },
  );

  /**
   * GET /api/projects/:projectId/analyses/:id/governing-findings
   * #1874 — the analysis's cited governing findings (Compliant / Gap / Needs BA
   * input, each citing its rule's control id and a clause of the revision it
   * was checked against), with their BA decisions, and the counts. #2017 —
   * `refreshing` is true while a findings run of the analysis is in flight or
   * queued (#2022: the run's own production at its join, or a refresh a BA
   * answer started): fetch again once it reads false. #2113 — `checked` is
   * false when no applicability is stored: the check never ran. 404 while
   * `GOVERNING_DOCS_ENABLED` is off. Scoped with `ensureAnalysisVisible`; rows
   * are read by the analysis id alone, which that check binds to the project.
   */
  projectScoped.get(
    "/:id/governing-findings",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      if (!isGoverningDocsEnabled()) throw new AppError(404, "NOT_FOUND", "Not found");
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);
      const [stored, applicability, states] = await Promise.all([
        listGoverningFindings(analysisId),
        readGoverningApplicability(analysisId),
        storedRequirementStates(analysisId, projectId),
      ]);
      // #2222 — each finding says which edited requirements it judged an
      // earlier wording of (`stale`); a re-checked requirement's own findings
      // are keyed by its id, and `requirementTitles` names it.
      const findings = withGoverningStaleness(stored, states, applicability);
      res.json(
        ok({
          findings,
          summary: summariseFindings(findings),
          // #1876 — each cited revision's rule count, for the analysis view's summary sentence.
          revisions: await governingFindingRevisions(findings),
          refreshing: governingFindingsRefreshing(analysisId),
          // #2113 — whether the governing check ran on this analysis at all
          // (its applicability is stored), so "not checked" (no rules in the
          // workspace, or a run that skipped the check) reads differently
          // from "checked, no rule applied". A stored set that is all errors
          // (rules unavailable, every requirement undecided) checked nothing.
          checked: applicability?.requirements.some((r) => !r.error) ?? false,
          requirementTitles: recheckedRequirementTitles(findings, states),
          // #2281 — requirements edited since the check that no finding offers a
          // re-check for: their analysed requirement produced no finding.
          editedWithoutFindings: editedWithoutFindings(findings, states, applicability),
        }),
      );
    },
  );

  /**
   * POST /api/projects/:projectId/analyses/:id/governing-findings/:findingId/decision
   * #1874 — a BA accepts or rejects one finding, with an optional note. The
   * decider is the session user, never the body (an unknown key is a 400). A
   * finding of another analysis is 404: it is looked up with this analysis's
   * id. An `AuditLog` row is written in the same transaction as the decision.
   */
  projectScoped.post(
    "/:id/governing-findings/:findingId/decision",
    requireAuth,
    requirePermission("analysis.run"),
    async (req: Request, res: Response) => {
      if (!isGoverningDocsEnabled()) throw new AppError(404, "NOT_FOUND", "Not found");
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);
      const parsed = governingFindingDecisionInputSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid decision payload", {
          issues: parsed.error.flatten(),
        });
      }
      const updated = await decideGoverningFinding({
        analysisId,
        findingId: String(req.params.findingId),
        decision: parsed.data.decision,
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
        decidedById: actorFromReq(req).id,
      });
      if (!updated) throw new AppError(404, "NOT_FOUND", "Governing finding not found");
      res.json(ok({ finding: updated }));
    },
  );

  /**
   * POST /api/projects/:projectId/analyses/:id/governing-findings/recheck
   * #2222 — Re-check this requirement: the governing check again on the
   * current wording of one stored requirement of this analysis, only. Answers
   * when its findings are stored, so a refetch shows them and the stale marker
   * gone. 404 while the flag is off, and for a requirement that is not a live
   * one of this analysis in this project; 409 when the workspace has no
   * current governing rule; 502 when the rules could not be read or the
   * requirement could not be evaluated (nothing is stored). The model calls are
   * metered to the project, as a clarify round's are. #2281 — rate limited
   * (several model calls each), and a client that goes away aborts the model
   * calls: nothing is stored and no answer is written.
   */
  projectScoped.post(
    "/:id/governing-findings/recheck",
    // Ahead of auth: CodeQL js/missing-rate-limiting.
    governingRecheckPreAuthRateLimiter,
    requireAuth,
    requirePermission("analysis.run"),
    governingRecheckUserRateLimiter,
    async (req: Request, res: Response) => {
      if (!isGoverningDocsEnabled()) throw new AppError(404, "NOT_FOUND", "Not found");
      // #2281 — the request's lifetime bounds the model calls. #2311 — attached
      // before the first await, so a client gone before the check starts runs none.
      const ac = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) ac.abort();
      });
      // Gone already (during the rate limiter's async store call): `close` fired
      // before the listener above was attached, so read the state instead. Not
      // `req.destroyed`: a live request is destroyed once its body has been read.
      if (!res.writableEnded && (res.closed || req.socket?.destroyed)) {
        ac.abort();
      }
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);
      const parsed = governingRecheckInputSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid re-check payload", {
          issues: parsed.error.flatten(),
        });
      }
      const provider = meterAnalysisProvider(buildProvider({ config: loadAIConfig() }));
      const outcome = await runInAnalysisUsageScope({ projectId, sessionId: analysisId }, () =>
        recheckGoverningRequirement({
          analysisId,
          projectId,
          requirementId: parsed.data.requirementId,
          provider,
          actorId: actorFromReq(req).id,
          signal: ac.signal,
        }),
      );
      // Nobody is left to answer.
      if (!outcome.ok && outcome.reason === "cancelled") return;
      if (outcome.ok) {
        res.json(ok(outcome.result));
        return;
      }
      if (outcome.reason === "not-found") {
        throw new AppError(404, "NOT_FOUND", "Requirement not found in this analysis");
      }
      if (outcome.reason === "no-rules") {
        throw new AppError(
          409,
          "NO_GOVERNING_RULES",
          "The workspace has no current governing rules",
        );
      }
      throw new AppError(502, "GOVERNING_RECHECK_FAILED", outcome.message);
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
      const analysis = await ensureAnalysisVisible(analysisId, projectId);

      // Issue #403 — validate at the trust boundary so malformed input is a
      // 400, not a 500 thrown from inside the dialog.
      const parsed = clarifyRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid clarification payload", {
          issues: parsed.error.flatten(),
        });
      }
      const body = parsed.data;

      const config = loadAIConfig();
      // #724 — clarify rounds are project spend: meter them, billed below.
      const provider = meterAnalysisProvider(buildProvider({ config }));
      const usageScope = { projectId, sessionId: analysisId };
      // Epic #922 — prefer the server-sourced structured requirements that the
      // enhancement pipeline persisted (#924). The client may still override by
      // passing `requirements` in the body, but it no longer has to reconstruct
      // them. Falls back to the request body when nothing was persisted.
      const stored = (await getStructuredRequirements(analysisId)) ?? undefined;
      // Self-resolution (clarify-self-resolve): give the dialog a retriever +
      // projectId so it can ground each clarifying question against the
      // project's ingested knowledge before asking. Grounding only runs on the
      // START branch; submitAnswers is unaffected.
      const dialog = new ClarificationDialog({
        provider,
        // #2431 — the grounded answers and their snippets are stored on the
        // analysis, read by every member: search as the shared audience.
        retriever: sharedAudienceRetriever(getKnowledgeService(), actorFromReq(req).id),
        projectId,
        // #2296 — the mode is the server's: decided from the list the
        // analysis stored, never from a client override's `sources`. Only an
        // analysis with nothing stored falls back to the override's.
        ...(stored ? { modeFrom: stored.requirements } : {}),
        // Issue #1129 — on a run from ticked items, their questions come first.
        askFirst: tickedFirst(await requirementOriginsFor(analysisId, analysis.metadata)),
        // #1873 — the business questions for uncertain governing rules, and
        // where their answers go. Undefined (no read) with the flag off.
        governingQuestions: governingQuestionSourceFor({ analysisId, projectId, provider }),
        // #2236 — a question the project has already settled is not asked again.
        priorAnswers: priorAnswerSourceFor(projectId, analysisId),
      });

      const override = body.requirements as StructuredRequirements | undefined;
      const requirements = override
        ? // The schema checks every field the dialog reads; the remaining
          // `StructuredRequirement` fields are carried through untouched.
          // #1657 — stamped with the run of the list stored now, so a run
          // that replaces the list during the model call is still caught by
          // the stale-run guard (`mergeClarifiedList`).
          { ...override, runId: stored?.runId }
        : stored;

      if (body.answers && body.answers.length > 0) {
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
        const answers = body.answers;
        // Epic #201 (#211) — close the feedback loop: persist the refined
        // requirements so they reach `Analysis.metadata` and flow downstream
        // into synthesis (#212). Issue #1602 — merged onto the list as it is
        // now, not written from the copy read before the model call, so a
        // requirement synthesis offered meanwhile (#1569) survives. #1668 /
        // #2142 — in the transaction that writes the round to the dialog
        // state, so a 409 for a replaced list rolls the round back with it and
        // leaves it open to answer again.
        const result = await runInAnalysisUsageScope(usageScope, () =>
          dialog.submitAnswers(analysisId, answers, requirements, undefined, (round, tx) =>
            persistClarifiedRound(analysisId, requirements, round, tx),
          ),
        );
        // Issue #1116 — and into the ARTIFACT path. `structuredRequirements` is
        // only what the approval view renders; the drafts (and the GitHub issues
        // they become) are built from the `Requirement` rows, which replay the
        // synthesis output produced BEFORE any question was asked. When the
        // approval gate is still withholding those rows this is a no-op and
        // `promoteApprovedRequirements` applies the answers instead.
        await applyClarificationsToRequirements(analysisId);
        // #2236 — the answers become project knowledge: recorded, indexed and
        // re-running what they change. After the response's work is
        // committed and off its path, metered to the project like the round.
        // #2310 — only the round this submit answered is recorded: an earlier
        // round's answer in an older analysis must not overwrite a newer one.
        const answeredRound = state.rounds.at(-1)?.round;
        void runInAnalysisUsageScope(usageScope, () =>
          persistClarificationKnowledge({
            projectId,
            analysisId,
            answeredById: req.user?.userId ?? null,
            provider,
            ...(answeredRound !== undefined ? { rounds: [answeredRound] } : {}),
          }),
        );
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
        // A dialog that is already settled returns its state unchanged, and the
        // UI starts it on every view: only a reuse this call added is re-run.
        const reusedBefore = (await readDialogState(analysisId))?.reused?.length ?? 0;
        const state = await runInAnalysisUsageScope(usageScope, () =>
          dialog.startOrContinue(analysisId, requirements),
        );
        // #2236 — answers reused from the project's records this round reach
        // the stored requirements as typed ones do.
        if (state.reused?.some((r) => r.round === state.currentRound)) {
          await applyClarificationsToRequirements(analysisId);
        }
        if ((state.reused?.length ?? 0) > reusedBefore) {
          // #2310 — and re-run what they change, as a typed answer does: off
          // the response's path, metered to the project like the round.
          const round = state.currentRound;
          void runInAnalysisUsageScope(usageScope, () =>
            rerunReusedClarifications({ projectId, analysisId, provider, round }),
          );
        }
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

      // #2447 — as for no dialog, to a reader who cannot see the run as a whole.
      const state = (await seesRunAsWhole(req, analysisId))
        ? await getDialogState(analysisId)
        : undefined;
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
      // #2016 — a governing question's requirement is one of the analysis's
      // own (its id is namespaced and in no reviewed list): labelled with that
      // requirement's text from the stored applicability, read only when the
      // round has such a question. An unreadable store still labels it.
      const governingText = new Map<string, string>();
      if (questions.some((q) => q.governing)) {
        const stored = await readGoverningApplicability(analysisId).catch((err: unknown) => {
          // #2022 — still labelled (by the raw id), but not silently.
          log.warn("governing applicability unreadable for the clarification export", {
            analysisId,
            error: (err as Error).message,
          });
          return null;
        });
        for (const r of stored?.requirements ?? []) governingText.set(r.requirementId, r.text);
      }

      const rows: ClarifyExportRow[] = questions.map((q) => ({
        questionId: q.id,
        requirement: q.governing
          ? governingQuestionRequirementLabel(governingText.get(q.governing.requirementId))
          : (titleById.get(q.requirementId) ?? q.requirementId),
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
    // #838 — the matrix loads the code graph: bounded per user (see the module).
    analysisMatrixPreAuthRateLimiter,
    requireAuth,
    requirePermission("analysis.read"),
    analysisMatrixUserRateLimiter,
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);

      const matrix = await getTraceabilityMatrix(analysisId, {
        loadSnapshot: snapshotLoaderFor(req),
      });
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

      // #856 — the per-project database-aware resolver decision (#854), the SAME
      // one the run path (#855) reads, is still resolved and echoed. #1137 — but
      // the report is one page of requirements, and their database changes are
      // NOT crossed here: that was 3.6 s and 487 KB of a 588 KB response for 33
      // requirements. The UI fetches them per requirement from the route below.
      const report = await getGapReport(analysisId, {
        ...(await resolveGapReportDeps(projectId)),
        loadSnapshot: snapshotLoaderFor(req),
        loadSchemaImpact: undefined,
        page: parseListPageQuery(req.query as Record<string, unknown>),
      });
      if (!report) throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      res.json(ok(report));
    },
  );

  /**
   * GET /api/projects/:projectId/analyses/:id/gap-report/requirements/:requirementId/database-changes
   *
   * #1137 — one requirement's database changes (#825/#847), computed when the
   * analyst opens them in the gap report. Gated by the same per-project
   * database-aware decision as the report (#856): off ⇒ an empty list plus the
   * reason. Authorized like the report, and the requirement must belong to the
   * analysis (404 otherwise, so no foreign requirement id is crossed). Rate
   * limited like the matrix: it loads the code graph.
   */
  projectScoped.get(
    "/:id/gap-report/requirements/:requirementId/database-changes",
    analysisMatrixPreAuthRateLimiter,
    requireAuth,
    requirePermission("analysis.read"),
    analysisMatrixUserRateLimiter,
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      const requirementId = String(req.params.requirementId);
      await ensureAnalysisVisible(analysisId, projectId);

      const requirement = await prisma.requirement.findFirst({
        where: { id: requirementId, analysisId, projectId, deletedAt: null },
        select: { id: true, analysisId: true, sourceIds: true },
      });
      // #2447 — one the caller cannot see a source of answers like an unknown one.
      if (!requirement || (await restrictedIds(readerOf(req), [requirement])).size > 0) {
        throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
      }
      res.json(ok(await getRequirementDatabaseChanges(analysisId, projectId, requirementId)));
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
    // #838 — the matrix loads the code graph: bounded per user (see the module).
    analysisMatrixPreAuthRateLimiter,
    requireAuth,
    requirePermission("analysis.read"),
    analysisMatrixUserRateLimiter,
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);

      // #847 — same producer on the export path so the downloaded report's
      // `databaseChanges` matches the /gap-report response (gated identically).
      // #856 — same resolver-driven gate as the /gap-report route above.
      const [gapReport, matrix] = await Promise.all([
        getGapReport(analysisId, {
          ...(await resolveGapReportDeps(projectId)),
          loadSnapshot: snapshotLoaderFor(req),
        }),
        getTraceabilityMatrix(analysisId, { loadSnapshot: snapshotLoaderFor(req) }),
      ]);
      if (!gapReport || !matrix) {
        throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      }

      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="analysis-report-${analysisId}.md"`,
      );
      res.send(
        serializeAnalysisReportMarkdown({
          gapReport,
          matrix,
          repoNames: await exportRepoNames(req, projectId),
        }),
      );
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
        reader: readerOf(req),
      });
      if (!diff) throw new AppError(404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      // #1137 — one page of the changed requirements (250 KB for 87 at once).
      const paged = sliceListPage(
        diff.entries,
        parseListPageQuery(req.query as Record<string, unknown>),
      );
      res.json(ok({ ...diff, entries: paged.items, page: paged.page }));
    },
  );

  /**
   * POST /api/projects/:projectId/analyses/:id/clarify/import
   * Consume a filled CSV, match answers to the current round by `questionId`,
   * and apply them through the EXISTING submit path (`submitAnswers` +
   * `persistClarifiedRequirements`). Returns `{ applied, skipped, unmatched }`,
   * and (#2101) the dialog `state` it wrote when any answer was applied.
   */
  projectScoped.post(
    "/:id/clarify/import",
    requireAuth,
    requirePermission("analysis.run"),
    documentFile,
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

      // #2101 — the state this import wrote, so the panel takes it at once
      // rather than showing the answered round until a refetch lands.
      let written: ClarificationState | undefined;
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
        // #724 — a CSV-imported round is clarify spend too.
        const provider = meterAnalysisProvider(buildProvider({ config }));
        const dialog = new ClarificationDialog({
          provider,
          // #2431 — as the start branch: the shared audience.
          retriever: sharedAudienceRetriever(getKnowledgeService(), actorFromReq(req).id),
          projectId,
          // #1873 — a CSV-imported answer settles governing rules too.
          governingQuestions: governingQuestionSourceFor({ analysisId, projectId, provider }),
        });
        // Issue #1602 — merged onto the list as it is now, as the JSON submit is,
        // and (#1668 / #2142) in the transaction that writes the round.
        const result = await runInAnalysisUsageScope({ projectId, sessionId: analysisId }, () =>
          dialog.submitAnswers(analysisId, applied, requirements, undefined, (round, tx) =>
            persistClarifiedRound(analysisId, requirements, round, tx),
          ),
        );
        written = result.state;
        // Issue #1116 — the CSV round-trip is the same submit path, so it must
        // reach the artifact the same way.
        await applyClarificationsToRequirements(analysisId);
        // #2236 — and become project knowledge the same way. #2310 — only
        // the round this import answered is recorded.
        const answeredRound = state.rounds.at(-1)?.round;
        void runInAnalysisUsageScope({ projectId, sessionId: analysisId }, () =>
          persistClarificationKnowledge({
            projectId,
            analysisId,
            answeredById: req.user?.userId ?? null,
            provider,
            ...(answeredRound !== undefined ? { rounds: [answeredRound] } : {}),
          }),
        );
      }

      res.json(ok({ applied: applied.length, skipped, unmatched, state: written }));
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
      const analysis = await ensureAnalysisVisible(analysisId, projectId);
      const status = req.query.status as string | undefined;
      const validStatuses = new Set(["pending", "approved", "rejected"]);
      const statusFilter =
        status && validStatuses.has(status)
          ? (status as "pending" | "approved" | "rejected")
          : undefined;
      const rows = await listApprovalRequests(analysisId, statusFilter);
      // Issue #1129 — say which requirement approvals restate a ticked imported
      // item and which the analysis added, so the panel can separate them.
      const origins = await requirementOriginsFor(analysisId, analysis.metadata);
      // Issue #1568 — and which would be promoted with no code link.
      const withoutCode = await requirementsWithoutCodeEvidenceFor(
        analysisId,
        rows,
        statusFilter !== undefined,
      );
      const items = rows.map((row) => {
        if (row.type !== "requirement") return row;
        const origin = origins.get(row.itemId);
        return {
          ...row,
          ...(origin ? { origin } : {}),
          ...(withoutCode.has(row.itemId) ? { noCodeEvidence: true } : {}),
        };
      });
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
   *
   * Issue #2167 — rate limited like its sibling approval writes: the pre-auth
   * ceiling ahead of `requireAuth`, then a per-user limiter of its own.
   */
  projectScoped.put(
    "/:id/approvals/:approvalId",
    // Per-IP, ahead of auth: CodeQL js/missing-rate-limiting (PR #902).
    analysisApprovalPreAuthRateLimiter,
    requireAuth,
    requirePermission("analysis.run"),
    analysisApprovalReviewRateLimiter,
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
        promotion = await promoteAndNote(analysisId, projectId, req);
      } catch {
        promotion = {
          status: "unavailable",
          reason: "Approval recorded, but promoting the requirements failed. Try again.",
        };
      }

      res.json(ok({ ...updated, promotion }));
    },
  );

  /**
   * POST /api/projects/:projectId/analyses/:id/approvals/promote
   * Issue #723 — promote the approved requirements of a run whose gate is open
   * but which has no requirement rows: a run stranded before rejections counted
   * as resolved has no review left to make, so the review PUT never fires again
   * and the Analysis page had no way to recover it. Same permission and scope
   * as the review PUT (#1097); `promoteApprovedRequirements` is idempotent and
   * never replaces an existing set. Refused only while the analysis is pending
   * or running: mid-run, the orchestrator has not saved its own requirements
   * yet. A failed or cancelled run is terminal — its approvals were resolved,
   * and the review PUT above would promote the very same run — so it is allowed.
   */
  projectScoped.post(
    "/:id/approvals/promote",
    // Per-IP, ahead of auth: CodeQL js/missing-rate-limiting (PR #902).
    analysisApprovalPreAuthRateLimiter,
    requireAuth,
    requirePermission("analysis.run"),
    analysisApprovalPromoteRateLimiter,
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      const analysis = await ensureAnalysisVisible(analysisId, projectId);
      if (analysis.status === "pending" || analysis.status === "running") {
        throw new AppError(
          409,
          "ANALYSIS_NOT_COMPLETED",
          "The analysis is still running — its requirements are saved when it completes.",
        );
      }

      let promotion: PromotionOutcome;
      try {
        promotion = await promoteAndNote(analysisId, projectId, req);
      } catch {
        promotion = {
          status: "unavailable",
          reason: "Promoting the requirements failed. Try again.",
        };
      }

      const actor = actorFromReq(req);
      audit({
        actor: { id: actor.id },
        action: "analysis.approval.promote",
        target: { type: "analysis", id: analysisId },
        metadata: { outcome: promotion.status },
      });

      res.json(ok({ promotion }));
    },
  );

  /**
   * POST /api/projects/:projectId/analyses/:id/criteria-proposals/dismiss-all
   * Issue #1389 — "Keep approved criteria for all": dismiss every acceptance
   * criteria suggestion a re-synthesis made for this analysis's approved
   * requirements, in one request. Same permission and limiters as answering
   * one (`POST /api/requirements/:id/criteria-proposal`). No content changes.
   */
  projectScoped.post(
    "/:id/criteria-proposals/dismiss-all",
    // Ahead of auth: CodeQL js/missing-rate-limiting.
    criteriaProposalPreAuthRateLimiter,
    requireAuth,
    requirePermission("project.update"),
    criteriaProposalUserRateLimiter,
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);
      const actor = actorFromReq(req);
      const dismissedCount = await dismissAllCriteriaProposals(analysisId);
      audit({
        actor: { id: actor.id },
        action: "analysis.criteria_proposal.dismiss_all",
        target: { type: "analysis", id: analysisId },
        metadata: { projectId, dismissedCount },
      });
      res.json(ok({ dismissedCount }));
    },
  );

  /**
   * GET /api/projects/:projectId/analyses/:id/withheld-replacement
   * Issue #780 — the comparison of the current requirement set with the
   * re-synthesis #769 withheld: what applying it would add, change, keep and
   * delete. 404 when there is none to review.
   */
  projectScoped.get(
    "/:id/withheld-replacement",
    // Ahead of auth: CodeQL js/missing-rate-limiting.
    withheldReplacementPreAuthRateLimiter,
    requireAuth,
    requirePermission("analysis.read"),
    withheldReplacementUserRateLimiter,
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);
      // #2447 — a re-synthesis rests on the run as a whole: as for none, to a
      // reader who cannot see every document it read.
      const diff = (await seesRunAsWhole(req, analysisId))
        ? await getWithheldReplacementDiff(analysisId)
        : null;
      if (!diff) {
        throw new AppError(
          404,
          "NO_WITHHELD_REPLACEMENT",
          "There is no withheld re-synthesis to review on this analysis",
        );
      }
      res.json(ok(diff));
    },
  );

  /**
   * POST /api/projects/:projectId/analyses/:id/withheld-replacement/:choice
   * Issue #780 — `apply` writes the withheld re-synthesis without deleting any
   * review work (reviewed requirements are updated through version history
   * with the analyst as author, or kept); `dismiss` discards it and changes no
   * requirement. Body `{ at }` names the refusal the analyst reviewed: a newer
   * one answers 409. Same permission as answering a #1389 criteria suggestion.
   */
  projectScoped.post(
    "/:id/withheld-replacement/:choice",
    withheldReplacementPreAuthRateLimiter,
    requireAuth,
    requirePermission("project.update"),
    withheldReplacementUserRateLimiter,
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      const choice = String(req.params.choice);
      if (choice !== "apply" && choice !== "dismiss") {
        throw new AppError(404, "NOT_FOUND", "Not found");
      }
      const at = (req.body as { at?: unknown } | undefined)?.at;
      if (typeof at !== "string" || at.length === 0 || at.length > 64) {
        throw new AppError(400, "VALIDATION_ERROR", "at must be the withheld re-synthesis time");
      }
      const fingerprint = (req.body as { fingerprint?: unknown } | undefined)?.fingerprint;
      if (
        choice === "apply" &&
        (typeof fingerprint !== "string" || fingerprint.length === 0 || fingerprint.length > 64)
      ) {
        throw new AppError(400, "VALIDATION_ERROR", "fingerprint must be the comparison's");
      }
      await ensureAnalysisVisible(analysisId, projectId);
      const actor = actorFromReq(req);
      try {
        if (choice === "apply") {
          const result = await applyWithheldReplacement({
            analysisId,
            projectId,
            actorId: actor.id,
            at,
            fingerprint: fingerprint as string,
          });
          const { insertedIds: _inserted, ...counts } = result;
          audit({
            actor: { id: actor.id },
            action: "analysis.replacement_withheld.apply",
            target: { type: "analysis", id: analysisId },
            metadata: { projectId, at, ...counts },
          });
          res.json(ok(counts));
          return;
        }
        const { discarded } = await dismissWithheldReplacement({ analysisId, at });
        audit({
          actor: { id: actor.id },
          action: "analysis.replacement_withheld.dismiss",
          target: { type: "analysis", id: analysisId },
          metadata: { projectId, at, discarded },
        });
        res.json(ok({ discarded }));
      } catch (err) {
        if (err instanceof WithheldReplacementError) {
          throw new AppError(409, err.code, err.message);
        }
        throw err;
      }
    },
  );

  /**
   * POST /api/projects/:projectId/analyses/:id/approvals/approve-all
   * Issue #939 — approve every pending approval of the analysis in one request,
   * then promote once. Approving 37 items needed 37 clicks (or a scripted loop).
   * Same permission and scope as the per-item review PUT (#1097); resolved
   * approvals are left as they are. Rate limited like promote, whose work it
   * ends in, and under the same per-user key.
   */
  projectScoped.post(
    "/:id/approvals/approve-all",
    // Per-IP, ahead of auth: CodeQL js/missing-rate-limiting (PR #902).
    analysisApprovalPreAuthRateLimiter,
    requireAuth,
    requirePermission("analysis.run"),
    analysisApprovalPromoteRateLimiter,
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      await ensureAnalysisVisible(analysisId, projectId);

      const rawNote = (req.body as { reviewNote?: unknown } | undefined)?.reviewNote;
      if (rawNote !== undefined && typeof rawNote !== "string") {
        throw new AppError(400, "VALIDATION_ERROR", "reviewNote must be a string");
      }
      const reviewNote = rawNote?.trim() ? rawNote.trim() : undefined;

      const actor = actorFromReq(req);
      const { approvedCount } = await approveAllPendingApprovalRequests(analysisId, {
        reviewerId: actor.id,
        reviewNote,
      });

      audit({
        actor: { id: actor.id },
        action: "analysis.approval.approve_all",
        target: { type: "analysis", id: analysisId },
        metadata: { approvedCount },
      });

      // Same best-effort promotion as the per-item review: the approvals stand
      // even when promotion fails, and the outcome is reported, not thrown.
      let promotion: PromotionOutcome;
      try {
        promotion = await promoteAndNote(analysisId, projectId, req);
      } catch {
        promotion = {
          status: "unavailable",
          reason: "Approvals recorded, but promoting the requirements failed. Try again.",
        };
      }

      res.json(ok({ approvedCount, promotion }));
    },
  );

  /**
   * POST /api/projects/:projectId/analyses/:id/approvals/reject-added
   * Issue #1129 — on a run started from ticked imported items, reject every
   * PENDING requirement approval the analysis added (one that restates no
   * ticked item), then promote once. Trimming 34 approvals to the five ticked
   * was 29 single clicks. The added set is computed here from the run's own
   * record, never taken from the client. Same permission, scope and limiters
   * as approve-all; each rejection can be reopened.
   */
  projectScoped.post(
    "/:id/approvals/reject-added",
    // Per-IP, ahead of auth: CodeQL js/missing-rate-limiting (PR #902).
    analysisApprovalPreAuthRateLimiter,
    requireAuth,
    requirePermission("analysis.run"),
    analysisApprovalPromoteRateLimiter,
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      const analysis = await ensureAnalysisVisible(analysisId, projectId);

      const origins = await requirementOriginsFor(analysisId, analysis.metadata);
      const addedIds = [...origins].filter(([, o]) => o === "added").map(([id]) => id);
      const actor = actorFromReq(req);
      const { rejectedCount } = await rejectPendingRequirementApprovals(analysisId, addedIds, {
        reviewerId: actor.id,
        reviewNote: "Left out: added by the analysis, not one of the ticked items.",
      });

      audit({
        actor: { id: actor.id },
        action: "analysis.approval.reject_added",
        target: { type: "analysis", id: analysisId },
        metadata: { rejectedCount },
      });

      let promotion: PromotionOutcome;
      try {
        promotion = await promoteAndNote(analysisId, projectId, req);
      } catch {
        promotion = {
          status: "unavailable",
          reason: "Rejections recorded, but promoting the requirements failed. Try again.",
        };
      }

      res.json(ok({ rejectedCount, promotion }));
    },
  );

  /**
   * POST /api/projects/:projectId/analyses/:id/approvals/:approvalId/reopen
   * Issue #723 — return a REJECTED approval to pending so it can be reviewed
   * again. A rejection used to be final, which left a mistaken rejection with
   * no way back short of a full re-run. Scoped exactly like the review route
   * (#1097): the analysis to its project, the approval to its analysis.
   */
  projectScoped.post(
    "/:id/approvals/:approvalId/reopen",
    // Per-IP, ahead of auth: CodeQL js/missing-rate-limiting (PR #902).
    analysisApprovalPreAuthRateLimiter,
    requireAuth,
    requirePermission("analysis.run"),
    analysisApprovalReopenRateLimiter,
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      const approvalId = String(req.params.approvalId);
      await ensureAnalysisVisible(analysisId, projectId);

      const actor = actorFromReq(req);
      const updated = await reopenApprovalRequest(analysisId, approvalId);

      audit({
        actor: { id: actor.id },
        action: "analysis.approval.reopen",
        target: { type: "approval_request", id: approvalId },
        metadata: { analysisId },
      });

      res.json(ok(updated));
    },
  );

  /**
   * PATCH /api/projects/:projectId/analyses/:id/approvals/:approvalId/requirement
   * Issue #1580 (`b-7-8`) — edit the title and description of the requirement a
   * PENDING `requirement` approval reviews, so a reviewer can correct it before
   * approving promotes it. Scoped like the review route (#1097): the analysis
   * to its project, the approval to its analysis. 409 once it is resolved.
   */
  projectScoped.patch(
    "/:id/approvals/:approvalId/requirement",
    // Per-IP, ahead of auth: CodeQL js/missing-rate-limiting (PR #902).
    analysisApprovalPreAuthRateLimiter,
    requireAuth,
    requirePermission("analysis.run"),
    analysisApprovalEditRateLimiter,
    async (req: Request, res: Response) => {
      const analysisId = String(req.params.id);
      const projectId = String(req.params.projectId);
      const approvalId = String(req.params.approvalId);
      const parsed = editCheckpointRequirementSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid requirement edit", {
          issues: parsed.error.flatten(),
        });
      }
      await ensureAnalysisVisible(analysisId, projectId);
      await ensureCheckpointEntryVisible(req, analysisId, approvalId);

      const actor = actorFromReq(req);
      const requirement = await editCheckpointRequirement(
        analysisId,
        approvalId,
        parsed.data,
        actor.id,
      );

      audit({
        actor: { id: actor.id },
        action: "analysis.approval.edit",
        target: { type: "approval_request", id: approvalId },
        metadata: { analysisId, fields: Object.keys(parsed.data) },
      });

      res.json(ok(requirement));
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

      const finding = await loadFindingForDeepDive({
        projectId,
        analysisId,
        findingId,
        reader: readerOf(req),
      });
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
      // #724 — the orchestrator's provider is metered; bill this call to the project.
      const result = await runInAnalysisUsageScope({ projectId, sessionId: analysisId }, () =>
        deepDiveFinding(ensureOrch().provider, {
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
        }),
      );

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
   * configured destination(s). Reuses the shared finding-publisher (marker
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

      const finding = await loadFindingForDeepDive({
        projectId,
        analysisId,
        findingId,
        reader: readerOf(req),
      });
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
            agentSource: finding.agentSource,
            severity: finding.severity,
            category: finding.category,
            draft: parsed.data.draft,
            provider,
            extraLabels: parsed.data.extraLabels,
            target: parsed.data.target,
            confirmCrossProject: parsed.data.confirmCrossProject === true,
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
        // #1180 — a GitHub target another project connects needs the caller's
        // confirmation; name that project only if this caller may open it.
        // GitHub is published before Jira, so a refusal here writes nothing.
        if (err instanceof CrossProjectRepoError && req.user) {
          throw await describeCrossProjectRefusal(err, req.user);
        }
        if (err instanceof PublishError) {
          const msg = err.message?.slice(0, 1000) ?? "publish failed";
          // Missing/incomplete destination config is a client-actionable 400
          // for the analysis publish flow (mirrors the Jira preflight above).
          // #733 — no explicit or configured GitHub target is the same kind
          // of client-actionable gap.
          if (err.code === "ERR_NOT_IMPLEMENTED" || err.code === "ERR_NO_PUBLISH_TARGET") {
            throw new AppError(400, err.code, msg);
          }
          throw new AppError(502, err.code || "PUBLISH_FAILED", msg);
        }
        throw err;
      }
    },
  );

  return { projectScoped, topLevel };
}
