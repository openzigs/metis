/**
 * Multi-agent analysis orchestrator (Phase 7 epic #53, #54-58).
 *
 * Pipeline:
 *   1. Cost-cap check + project visibility/state guard
 *   2. Persist a fresh `Analysis` row in `running` state
 *   3. Run the four specialist agents IN PARALLEL with a per-agent
 *      AbortController; each emits `analysis:agent` socket events
 *   4. Persist each agent's output and findings as it completes
 *   5. Run the LLM synthesis agent over the merged finding list
 *   6. Persist requirements
 *   7. Roll up token usage and mark the `Analysis` row terminal
 *
 * Note on RBAC: route-level `requirePermission("analysis.run")` is the
 * authoritative authorization gate. Metis has no per-project membership
 * model today; the orchestrator only enforces project existence and
 * non-archived state. Add a project-membership check here when one ships.
 *
 * Cancellation: `cancel(analysisId)` aborts every in-flight signal and
 * marks the Analysis as `cancelled`. Partial findings are preserved.
 */
import {
  type AGENT_RESULT_STATUSES,
  type AnalysisAgentEvent,
  type AnalysisCapability,
  type AnalysisCapabilityEvent,
  type AnalysisDatabaseAware,
  type AnalysisReposSkippedEvent,
  type AnalysisRetrievalHealth,
  type AnalysisSkippedRepo,
  type AnalysisAgentKey,
  type AnalysisSpecialistAgentKey,
  type AgentOutput,
  type DatabaseAwareAnalysisSetting,
  ANALYSIS_RETRIEVE_K,
  ANALYSIS_SPECIALIST_AGENT_KEYS,
  DATABASE_AWARE_ANALYSIS_SETTINGS,
  DEFAULT_DATABASE_AWARE_ANALYSIS_SETTING,
  deriveCapabilityReasons,
  isCodeCitation,
  MAX_REQUIREMENTS_FOR_RETRIEVAL,
  // Epic #1107 (#1110) — the shared ranking primitive. Imported from the seam
  // rather than re-exported through `synthesis.js` so it stays available in the
  // many pipeline tests that mock that module wholesale.
  orderByPanelConfidence,
  REQUIREMENT_RETRIEVAL_CONCURRENCY,
} from "@metis/shared";
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import type { AIProvider, TokenUsage } from "../ai/types.js";
import { getKnowledgeService, type KnowledgeService } from "../rag/knowledge-service.js";
import type { MetisIOServer } from "../socket/server.js";
import { jobEvents, genericFailureMessage } from "../socket/job-events.js";
import {
  runAgent,
  enrichCitations,
  extractJsonObject,
  repairMaxOutputTokens,
  // #1224 — moved to `agent-runner.ts` so the single-shot `runAgent` call can
  // share this one knob with the agentic final-answer retry.
  resolveFinalAnswerMaxOutputTokens,
  type AgentRunResult,
  type RetrievalContextChunk,
} from "./agent-runner.js";
import {
  buildCodeProvenance,
  collectToolProvenance,
  groundCodeCitations,
  type DroppedCitation,
} from "./code-citations.js";
import { getPersona } from "./personas.js";
import { withInvokeAgentSpan } from "../otel/genai-spans.js";
import {
  startRun as startReplayRun,
  recordStep as recordReplayStep,
  finishRun as finishReplayRun,
  computeRunCost as computeReplayRunCost,
} from "../replay/runs-service.js";
import {
  createAnalysis,
  finalizeAnalysisDelta,
  getAnalysisCapability,
  getStructuredRequirements,
  markAnalysisCancelled,
  markAnalysisCompleted,
  markAnalysisFailed,
  persistAgentResult,
  persistAnalysisEnhancement,
  persistAnalysisCapability,
  persistAnalysisAffectedCode,
  persistAnalysisDatabaseAware,
  persistAnalysisEscalation,
  persistRequirements,
  readFlattenedFindings,
} from "./analysis-service.js";
import { computeCoverageForRequirements } from "./requirement-coverage.js";
// Issue #1104 (finding B) — shared wording for a gated (withheld) promotion.
import { describePromotionGate } from "./promotion-gate.js";
import { verifyFinding } from "./finding-verification.js";
// #1318 (Epic #1316) — the claim-level faithfulness METRIC. A grader like the
// panel below, one step further: it writes ONE optional numeric field and cannot
// reach the deterministic gate at all.
import { applyFindingFaithfulness } from "./finding-faithfulness.js";
// #1109 (Epic #1107) — the multi-lens support panel: a GRADER that runs after
// the deterministic verifier and adds a confidence signal. Never a gate.
import { applySupportPanel, collectPanelEvidence } from "./support-panel.js";
import {
  absenceIsConfirmable,
  assessInvestigationCoverage,
  countUnverifiedRequirements,
  absenceIsConfirmableForClaim,
  mergeRetrievalHealth,
  noRetrievalHealth,
  summarizeRetrievalEvidence,
} from "./retrieval-health.js";
import {
  assertsAbsence,
  computeVerdictsForRequirements,
  gateFindingVerdict,
  retitleUnverifiableFinding,
  schemaEvidenceFromAffectedRows,
  type VerdictFindingInput,
} from "./requirement-verdict.js";
import {
  type CapabilityTracker,
  createCapabilityTracker,
  detectCodeAgentFailed,
  detectStaticCapability,
  finalizeCapability,
} from "./analysis-capability.js";
// #777 — the file tools are gated on the clone EXISTING, not on a path string.
import { cloneDirPath, resolveExistingCloneDir } from "./clone-availability.js";
import { assertCanStartAnalysis, getProjectMonthlyAnalysisTokens } from "./cost-cap.js";
import { notifyAnalysisComplete } from "../teams/notification-hooks.js";
import {
  createApprovalRequests,
  canCreateTickets,
  type ApprovalPolicy,
} from "./approval-checkpoint.js";
import type { ApprovalType } from "./types/requirements.js";
import { runSynthesis, type FlatFinding } from "./synthesis.js";
import { runCrossDocDetection } from "./cross-doc-detection.js";
import { persistCrossDocFindings } from "./analysis-service.js";
import type { DocSegment } from "./cross-doc-validator.js";
import {
  formatElicitedArtifacts,
  isEmptyElicitation,
  runElicitation,
} from "./elicitation-pipeline.js";
import { runAgentLoop, buildCachedSystemPrompt } from "./agent-loop.js";
import { summarizeToolCalls, type ToolCallRecord } from "./tool-telemetry.js";
import {
  FINAL_ANSWER_INSTRUCTION,
  buildDegradedAgentOutput,
  isJsonFinalAnswer,
  isSchemaValidFinalAnswer,
  salvageWithRepair,
  selectSalvageSource,
  type AgenticDegradationReason,
} from "./agentic-degradation.js";
import { getConfigService } from "../config/config-service.js";
import { seedRequirementCodeLinksFromFindings } from "../traceability/seed-code-links-from-findings.js";
import { runEnabledCustomAgents } from "./custom-agent-phase.js";
import { RequirementsExtractor } from "./requirements-extractor.js";
import { WebResearchAugmenter, createSearchProvider } from "./web-research-augmenter.js";
import {
  searchCodeGraphTool,
  readFileSliceTool,
  listFilesTool,
  createSearchKnowledgeTool,
  createSearchSymbolsTool,
  createDescribeTableTool,
  type DescribeTableDeps,
  type AgentTool,
  type ToolContext,
} from "./tools/index.js";
import { buildAgenticCodePrompt, buildRequirementGroundedPrompt } from "./prompts.js";
import {
  buildRetrievalQueries,
  CODE_REQUIREMENTS_QUERY,
  deriveRetrievalQuery,
  RETRIEVAL_QUERIES,
  retrievePerRequirement,
  runGroundedRetrieval,
} from "./retrieval.js";
import {
  retrieveFusedCodeChunks,
  retrieveFusedCodeContext,
  type AnalysisFusedCodeDeps,
} from "./fused-code-chunks.js";
import {
  retrieveSchemaContextChunks,
  introspectProjectSchema,
  type AnalysisSchemaContextDeps,
} from "./schema-context.js";
import { listDbConnectors } from "../connectors/db/db-service.js";
import {
  computeAffectedCodeContext,
  EMPTY_AFFECTED_CODE_CONTEXT,
  type AffectedCodeContext,
  type AffectedCodeDeps,
} from "./affected-code-context.js";
import {
  computeRunAffectedSchemaContext,
  EMPTY_AFFECTED_SCHEMA_CONTEXT,
  type AffectedSchemaContext,
  type RunAffectedSchemaDeps,
} from "./affected-schema-context.js";
import {
  resolveDatabaseAwareAnalysis,
  readDbAwareEnvDefault,
  hasSchemaData as probeHasSchemaData,
  type DbAwareEnvDefault,
  type SchemaDataPrismaClient,
} from "./database-aware-resolver.js";
import {
  buildRequirementInputAccount,
  extractNewRequirementCandidates,
  extractNewRequirementCandidatesWithAccount,
  mergeRequirementSets,
  mergeRequirementSetsWithAccount,
  type RequirementRef,
} from "./new-requirements.js";
import { computeRequirementEscalations } from "./escalation-context.js";
import { splitEscalationBudget, type EscalationPolicyConfig } from "./escalation-policy.js";
import type { RequirementEscalation } from "@metis/shared";
import { TaskProfiler } from "../ai/task-profiler.js";
import {
  ModelRouter,
  type ModelPreferences,
  HAIKU_MODEL_ID,
  SONNET_MODEL_ID,
} from "../ai/model-router.js";

const log = createChildLogger("analysis-orchestrator");

/**
 * #734 — build the `onDrop` sink for {@link groundCodeCitations}. A dropped code
 * citation means the model cited a `file:line` (or synthetic `code-graph:` id)
 * that was NOT in the retrieved provenance — an anti-hallucination drop that must
 * be observable, never silent, so it is emitted as a structured warn log.
 */
function makeCitationDropLogger(
  analysisId: string,
  agentKey: string,
  mode: "agentic" | "requirement-grounded",
): (dropped: DroppedCitation) => void {
  return (dropped) =>
    log.warn("Dropped ungrounded code citation", {
      analysisId,
      agentKey,
      mode,
      filePath: dropped.filePath,
      reason: dropped.reason,
    });
}

/**
 * Thrown by {@link AnalysisOrchestrator.regenerateAgent} when the analysis is
 * not in a terminal state. Routes map this to HTTP 409.
 */
export class AnalysisNotRegeneratableError extends Error {
  readonly code = "ANALYSIS_NOT_REGENERATABLE";
  readonly status = 409;
  constructor(
    public readonly analysisId: string,
    public readonly currentStatus: string,
  ) {
    super(`Analysis ${analysisId} cannot be regenerated while status=${currentStatus}`);
    this.name = "AnalysisNotRegeneratableError";
  }
}

const REGENERATABLE_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface OrchestratorDeps {
  provider: AIProvider;
  knowledge?: KnowledgeService;
  io?: MetisIOServer;
  /** Test seam \u2014 override the retrieval call entirely. */
  retrieve?: (input: {
    projectId: string;
    agentKey: AnalysisSpecialistAgentKey;
    documentIds?: string[];
  }) => Promise<RetrievalContextChunk[]>;
  /**
   * #729 (Epic #725) \u2014 injectable fused code-graph retrieval seam for the code
   * agent's context. Defaults to the production BM25 searcher + `CodeSymbol`
   * line lookup (shared with chat/Spec-Kit #714). Env-gated ON by default via
   * `ANALYSIS_FUSED_CODE_RETRIEVAL` (#752); an operator can set it `=false` to
   * restore the pre-#729 no-op behaviour.
   */
  fusedCode?: AnalysisFusedCodeDeps;
  /**
   * #732 (Epic #725) — injectable schema-context seam for the DATABASE agent's
   * (Sally's) context. Defaults to the production read-only connector
   * introspection + persisted usage classification. Env-gated ON by default via
   * `ANALYSIS_SCHEMA_CONTEXT` (#752); an operator can set it `=false` to restore
   * the pre-#732 docs-only behaviour.
   */
  schemaContext?: AnalysisSchemaContextDeps;
  /**
   * #735 (Epic #726) — injectable seam for the deterministic requirement→code
   * mapping fed into the code agent's gap prompt. Defaults to the production
   * BM25 mapper + Prisma code-graph data source (Impact Analysis machinery).
   * Env-gated ON by default via `ANALYSIS_AFFECTED_CODE_MAPPING`; an operator
   * can set it `=false` to restore the pre-#735 behaviour.
   */
  affectedCode?: AffectedCodeDeps;
  /**
   * #824 (Epic #820 Phase 1) — injectable seam for the deterministic AFFECTED
   * SCHEMA block crossed into the database (Sally), code, and synthesis prompts.
   * Defaults to the production BM25 mapper + Prisma code/schema-graph data
   * sources (#823 crossing). Env-gated OFF by default via
   * `ANALYSIS_AFFECTED_SCHEMA_MAPPING`; when disabled the prompts are
   * byte-identical to the pre-#824 behaviour.
   */
  affectedSchemaMapping?: RunAffectedSchemaDeps;
}
/** Agent execution mode for the analysis pipeline. */
export type AgentMode = "single-shot" | "agentic" | "requirement-grounded";

/**
 * #739 (Epic #727) — the per-run escalation decision threaded into the agentic
 * code pass: which requirements were routed `deep` vs `standard`, and the turn
 * caps to use for each pass. Undefined when the policy is disabled (the default).
 */
interface RunEscalation {
  decisions: RequirementEscalation[];
  policy: EscalationPolicyConfig;
}

/**
 * Issue #1104 (finding B) — what the synthesis phase reports back to the run.
 * `promotionBlocked` is set when synthesis produced requirements that the
 * approval gate withheld, so the run can finish HONESTLY ("N requirements
 * awaiting approval") instead of announcing a bare "Analysis complete" for a
 * run whose entire output is invisible to the user.
 */
interface SynthesisOutcome {
  promotionBlocked?: {
    pendingCount: number;
    rejectedCount: number;
    awaitingRequirementCount: number;
    reason: string;
  };
}

/** Default token budget per agentic agent loop (100k tokens). */
const DEFAULT_AGENT_TOKEN_BUDGET = 100_000;
/** Minimum token budget per repo in multi-repo analysis (#663 review). */
const MIN_PER_REPO_TOKEN_BUDGET = 50_000;
/** Default max turns for the agentic loop (the FLOOR — see {@link resolveAgenticMaxTurns}). */
const DEFAULT_AGENTIC_MAX_TURNS = 10;
/**
 * Issue #773 — turns granted PER REQUIREMENT in a pass (one search + one read is
 * the minimum honest investigation of a single requirement).
 */
const DEFAULT_AGENTIC_TURNS_PER_REQUIREMENT = 2;
/**
 * Issue #773 — hard ceiling on the scaled turn cap, so a huge requirement set cannot
 * run away. 60 turns funds one search + one read for the ~30-requirement analyses
 * this product routinely runs (the reported incident had 20). Turns do not raise the
 * ceiling on SPEND — `ANALYSIS_AGENT_TOKEN_BUDGET` still bounds that — they only
 * decide how many requirements a pass can afford to actually look for.
 */
const DEFAULT_AGENTIC_MAX_TURNS_CAP = 60;

/**
 * #769 — the agentic loop's depth knobs are now operator-tunable, so a run that
 * legitimately needs to investigate more requirements can be given more room
 * WITHOUT a redeploy. The DEFAULTS are deliberately unchanged (10 turns /
 * 100k tokens): raising them would raise cost + latency for every run, and the
 * reported failure was a serialization bug, not a depth shortfall — the loop
 * now salvages its work either way.
 */
/**
 * Issue #773 — BUDGET STARVATION. A flat 10-turn cap against ~20 requirements made
 * "no evidence found" outcomes STRUCTURALLY PREDETERMINED: the agent could not
 * physically investigate every requirement, and the pipeline then reported the
 * ones it never reached as confirmed gaps. Two changes close that:
 *
 *   1. A requirement the agent never investigated is `could-not-verify`, never a
 *      gap (`deriveRequirementVerdict`'s final rule + the per-claim evidence
 *      threshold: a gap needs a working search that BORE ON that requirement).
 *   2. The turn cap SCALES with the size of the pass, so a working search per
 *      requirement is FUNDABLE rather than impossible by construction.
 *
 * The evidence threshold is now scale-free (per-claim, not a pass-wide quota), so
 * a pass that cannot afford to search for every requirement degrades GRACEFULLY —
 * it confirms gaps for the ones it did search and says `could-not-verify` about
 * the rest — instead of hitting a cliff where nothing is confirmable. The turn cap
 * therefore governs HOW MANY requirements a pass can settle, never WHETHER it can
 * settle any.
 *
 * The configured `ANALYSIS_AGENTIC_MAX_TURNS` remains the FLOOR (a small pass is
 * byte-identical to before), and the scaled value is capped by
 * `ANALYSIS_AGENTIC_MAX_TURNS_CAP`. This cannot raise the ceiling on SPEND: the
 * loop is still bounded by `ANALYSIS_AGENT_TOKEN_BUDGET`, which turns do not change.
 */
function resolveAgenticMaxTurns(requirementCount = 0): number {
  const cfg = getConfigService();
  const floor = cfg.getNumber("ANALYSIS_AGENTIC_MAX_TURNS", DEFAULT_AGENTIC_MAX_TURNS);
  const perRequirement = cfg.getNumber(
    "ANALYSIS_AGENTIC_TURNS_PER_REQUIREMENT",
    DEFAULT_AGENTIC_TURNS_PER_REQUIREMENT,
  );
  const cap = cfg.getNumber("ANALYSIS_AGENTIC_MAX_TURNS_CAP", DEFAULT_AGENTIC_MAX_TURNS_CAP);
  const scaled = Math.ceil(Math.max(0, requirementCount) * perRequirement);
  const turns = Math.min(Math.max(floor, scaled), Math.max(floor, cap));
  // One turn must emit the final answer, so the pass can make at most `turns - 1`
  // tool calls. Below one call per requirement it CANNOT look for every
  // requirement, and the ones it never searched for will (correctly) come back
  // `could-not-verify` rather than as gaps. That is a budget decision, so say so
  // out loud rather than letting an operator who lowered the cap wonder why their
  // large analyses stopped confirming gaps.
  if (requirementCount > 0 && turns - 1 < requirementCount) {
    log.warn("Agentic turn cap cannot fund one search per requirement", {
      requirementCount,
      turns,
      maxToolCalls: turns - 1,
      hint: "Raise ANALYSIS_AGENTIC_MAX_TURNS_CAP / ANALYSIS_AGENTIC_TURNS_PER_REQUIREMENT; requirements the pass cannot search for are reported could-not-verify, never as confirmed gaps.",
    });
  }
  return turns;
}
function resolveAgentTokenBudget(): number {
  return getConfigService().getNumber("ANALYSIS_AGENT_TOKEN_BUDGET", DEFAULT_AGENT_TOKEN_BUDGET);
}

/** A connector reference the budget capper accepts (id + display label). */
export interface BudgetCapConnector {
  id: string;
  label: string;
}

/**
 * Issue #741 (Epic #727) — PURE multi-repo budget split + cap.
 *
 * Splits `totalBudget` evenly across `connectors`. When the even split would
 * fall below `minPerRepo`, the repo list is truncated to the largest count that
 * still clears the floor, the survivors get the (larger) re-split budget, and
 * the dropped connectors are returned so the caller can surface + persist them
 * (rather than silently dropping repos). Shared by the initial agentic run and
 * the resume endpoint so both cap identically — the resume re-caps its own
 * skipped set, which is the loop guard (a resume that still can't fit every
 * repo persists the remaining-skipped list again).
 */
export function capConnectorsForBudget<T extends BudgetCapConnector>(
  connectors: T[],
  totalBudget: number,
  minPerRepo: number = MIN_PER_REPO_TOKEN_BUDGET,
): { effectiveConnectors: T[]; effectiveBudget: number; skipped: T[] } {
  if (connectors.length === 0) {
    return { effectiveConnectors: [], effectiveBudget: totalBudget, skipped: [] };
  }
  const perConnectorBudget = Math.floor(totalBudget / connectors.length);
  if (perConnectorBudget >= minPerRepo) {
    return { effectiveConnectors: connectors, effectiveBudget: perConnectorBudget, skipped: [] };
  }
  // At least one repo always runs, even when a single repo can't clear the floor
  // (it still gets the full budget — the floor is an ideal, not a hard gate).
  const maxRepos = Math.max(1, Math.floor(totalBudget / minPerRepo));
  const effectiveConnectors = connectors.slice(0, maxRepos);
  return {
    effectiveConnectors,
    effectiveBudget: Math.floor(totalBudget / effectiveConnectors.length),
    skipped: connectors.slice(maxRepos),
  };
}

/** Sum two token-usage records (used to merge #739's split agentic passes). */
function sumTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/**
 * Assemble the tool set offered to Winston's agentic code loop (#730, Epic #725).
 *
 * The loop always gets:
 *   - `search_code_graph` — exact qualified-name / caller / callee graph traversal.
 *   - `search_knowledge` — document-level RAG retrieval.
 *   - `search_code_symbols` (#730) — hybrid BM25 + vector RRF symbol search, the
 *     same tool chat got in Epic #712. It is COMPLEMENTARY to #729's passive
 *     fused-symbol seeding: the seed grounds turn 1 from a derived project/
 *     requirements query, while this tool lets the agent run its OWN follow-up
 *     symbol queries mid-loop. Both hit the SAME injectable searcher/line-lookup
 *     seam (`fusedCodeDeps`), so there is a single source of truth for the symbol
 *     index and tests can stub it once.
 *   - `read_file_slice` + `list_files` — ONLY when a repo clone dir EXISTS ON DISK.
 *
 * #777 — `cloneDir` MUST be a path already VERIFIED to exist
 * ({@link resolveExistingCloneDir}), never a speculatively-built one. This gate used to
 * be a truthy check on an unconditionally-constructed path string, so a connector ROW
 * was enough to offer both file tools; on a fully-indexed but clone-less project they
 * then failed on every call (69–71% of all tool calls, per #774 telemetry), burned the
 * turn budget, and tripped #773's error-rate threshold into a blanket
 * `could-not-verify`. Offering a tool that cannot work is worse than not offering it.
 *
 * `runAgenticCodeAgent` is only entered when a built code graph exists
 * (`detectAgentMode`), so `search_code_symbols` is always in-scope here; a project
 * whose symbol index is empty degrades to a clean "no matching symbols" tool
 * result (never a throw — see `createSearchSymbolsTool`). Array order is NOT
 * significant: `formatToolSchemas` sorts by name (`sortToolsForCache`) before
 * rendering into the cache-stable prompt lead, so the schema position is
 * deterministic regardless of push order.
 */
export function assembleAgenticCodeTools(input: {
  knowledgeService: KnowledgeService;
  /** #777 — a VERIFIED-EXISTING clone dir. Undefined ⇒ no working tree ⇒ no file tools. */
  cloneDir?: string;
  fusedCodeDeps?: AnalysisFusedCodeDeps;
  /**
   * #1312 — bound schema introspector. Supplied ONLY when the project has an
   * introspectable DB connector, so `describe_table` is withheld rather than
   * offered-and-broken on a project with no database (the #777 rule).
   */
  describeTableDeps?: DescribeTableDeps;
}): AgentTool[] {
  const tools: AgentTool[] = [searchCodeGraphTool];
  if (input.cloneDir) {
    tools.push(readFileSliceTool, listFilesTool);
  }
  tools.push(createSearchKnowledgeTool({ knowledgeService: input.knowledgeService }));
  // #730 — hybrid symbol search shares the #714/#729 searcher + line-lookup seam.
  tools.push(createSearchSymbolsTool(input.fusedCodeDeps));
  if (input.describeTableDeps) {
    tools.push(createDescribeTableTool(input.describeTableDeps));
  }
  return tools;
}

/**
 * #777 — the tools that require a WORKING TREE, named from the tool definitions
 * themselves so this set can never drift from what `assembleAgenticCodeTools` pushes.
 *
 * When the clone is absent these are WITHHELD, and this set is handed to
 * `summarizeRetrievalEvidence` as `unavailableTools` so that a model which calls one
 * anyway (earning the loop's "Unknown tool" repair error) cannot drag the run's
 * retrieval health down. An absent clone is a KNOWN CAPABILITY LIMIT — it is not
 * evidence that code retrieval failed, and must not be laundered into one.
 */
export const REPO_FILE_TOOLS: ReadonlySet<string> = new Set([
  readFileSliceTool.name,
  listFilesTool.name,
]);

/** No tool was withheld — the run has a working tree. */
const NO_WITHHELD_TOOLS: ReadonlySet<string> = new Set();

export interface StartAnalysisOptions {
  projectId: string;
  startedById: string;
  agentKeys?: AnalysisSpecialistAgentKey[];
  documentIds?: string[];
  model?: string;
  /**
   * Free-text "new requirements" to evaluate (requirements → code gap, #905).
   * Persisted to analysis metadata and forwarded to the agent prompt via
   * `escapeContext` (untrusted data boundary — never raw instructions).
   */
  extraInstructions?: string;
  /**
   * Epic #922 — opt-in: run web research on requirement evidence needs. When
   * false (default) the augmenter is never constructed. No-op when offline.
   */
  enableWebResearch?: boolean;
  /**
   * Epic #922 — opt-in: extract structured requirements and surface clarifying
   * questions for ambiguous items. When false (default) extraction is skipped.
   */
  enableClarification?: boolean;
}

interface ActiveRun {
  analysisId: string;
  controllers: Map<string, AbortController>;
  cancelled: boolean;
}

/** #741 (Epic #727) — outcome of a multi-repo budget resume. */
export interface ResumeSkippedReposResult {
  /** Connectors re-analyzed on this resume (findings merged into the analysis). */
  resumed: AnalysisSkippedRepo[];
  /** Connectors STILL skipped after re-capping the resume set (loop guard). */
  remaining: AnalysisSkippedRepo[];
  /** True when there was nothing to resume — an idempotent no-op. */
  noop: boolean;
}

export class AnalysisOrchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly active = new Map<string, ActiveRun>();
  /**
   * Issue #733 — per-run capability trackers, keyed by analysisId. Seeded at run
   * start and mutated as the run discovers degraded modes (agent mode, quarantine
   * fallback, skipped repos), then finalized + persisted at completion.
   */
  private readonly capabilities = new Map<string, CapabilityTracker>();
  /**
   * Issue #773 — per-run code-retrieval health, keyed by analysisId. One entry per
   * agentic code pass (a multi-repo run contributes one per connector); merged at
   * finalize into the record persisted for the gap report's searched-scope
   * provenance and the `code-retrieval-degraded` capability reason.
   */
  private readonly retrievalHealths = new Map<string, AnalysisRetrievalHealth[]>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /** Issue #178 — expose the configured AI provider for one-shot helpers (deep-dive). */
  get provider(): AIProvider {
    return this.deps.provider;
  }

  /**
   * Start a fresh analysis. Returns the persisted Analysis row immediately;
   * the heavy work runs in the background and progress streams over Socket.IO.
   */
  async start(opts: StartAnalysisOptions): Promise<{ id: string }> {
    await assertCanStartAnalysis();
    const project = await prisma.project.findFirst({
      where: { id: opts.projectId, deletedAt: null },
    });
    if (!project) {
      throw new Error(`Project ${opts.projectId} not found`);
    }
    if (project.status === "archived") {
      throw new Error(`Project ${opts.projectId} is archived`);
    }
    const agentKeys =
      opts.agentKeys && opts.agentKeys.length > 0
        ? opts.agentKeys
        : [...ANALYSIS_SPECIALIST_AGENT_KEYS];

    const row = await createAnalysis({
      projectId: opts.projectId,
      startedById: opts.startedById,
      agentKeys,
      documentIds: opts.documentIds,
      model: opts.model,
      extraInstructions: opts.extraInstructions,
    });

    audit({
      actor: { id: opts.startedById },
      action: "analysis.start",
      target: { type: "analysis", id: row.id },
      metadata: {
        projectId: opts.projectId,
        agentKeys,
        personas: agentKeys.map((k) => {
          const p = getPersona(k);
          return { agentKey: k, name: p.name, role: p.role };
        }),
        documentCount: opts.documentIds?.length ?? null,
        model: opts.model ?? null,
        hasExtraInstructions: Boolean(opts.extraInstructions),
      },
    });

    // Resolve model override strings to actual model IDs so the provider
    // receives a valid Bedrock identifier.
    const resolvedOpts = { ...opts };
    if (opts.model === "force-sonnet") resolvedOpts.model = SONNET_MODEL_ID;
    else if (opts.model === "force-haiku") resolvedOpts.model = HAIKU_MODEL_ID;

    // Run pipeline in the background. Errors are recorded against the
    // Analysis row \u2014 they never bubble up to the caller.
    // Issue #855 (Epic #852) \u2014 thread the project's `databaseAwareAnalysis`
    // setting through (already loaded above, no extra query) so the run path
    // can resolve it via #854's resolver instead of the bare env flag.
    void this.runPipeline(
      row.id,
      project.name,
      project.description,
      agentKeys,
      resolvedOpts,
      project.databaseAwareAnalysis,
    );

    return { id: row.id };
  }

  /**
   * Synchronous pre-flight for `regenerateAgent`. Validates cost-cap, project
   * state, and that the analysis is in a regeneratable (terminal) state.
   * Throws {@link CostCapExceededError} or {@link AnalysisNotRegeneratableError}
   * — callers (route handlers) translate these to 429 / 409 before kicking
   * off the long-running pipeline.
   */
  async assertCanRegenerate(analysisId: string): Promise<{
    analysis: Awaited<ReturnType<typeof prisma.analysis.findFirst>>;
  }> {
    await assertCanStartAnalysis();
    const analysis = await prisma.analysis.findFirst({
      where: { id: analysisId, deletedAt: null },
      include: { project: true },
    });
    if (!analysis) throw new Error(`Analysis ${analysisId} not found`);
    if ((analysis as { project: { status: string } }).project.status === "archived") {
      throw new Error("Project is archived");
    }
    if (!REGENERATABLE_STATUSES.has((analysis as { status: string }).status)) {
      throw new AnalysisNotRegeneratableError(analysisId, (analysis as { status: string }).status);
    }
    if (this.active.has(analysisId)) {
      throw new AnalysisNotRegeneratableError(analysisId, "running");
    }
    return { analysis };
  }

  /**
   * Re-run a single specialist agent on an existing analysis (#57). Re-runs
   * synthesis afterwards so requirements stay consistent with findings.
   *
   * Pre-flight guards:
   *   - Cost cap (defence in depth on top of the route-level pre-check).
   *   - Analysis must be in a terminal state (`completed`/`failed`/`cancelled`)
   *     so we don't clobber an in-flight pipeline.
   *   - Analysis must not already have an in-memory `ActiveRun`.
   *
   * Token totals are written via atomic SQL `increment` deltas — never via
   * read/modify/write — so concurrent regenerates cannot corrupt the rollup.
   */
  async regenerateAgent(opts: {
    analysisId: string;
    agentKey: AnalysisSpecialistAgentKey;
    actorId: string;
  }): Promise<void> {
    const { analysis: maybeAnalysis } = await this.assertCanRegenerate(opts.analysisId);
    const analysis = maybeAnalysis as NonNullable<typeof maybeAnalysis> & {
      project: { name: string; description: string; status: string };
      projectId: string;
      metadata: string | null;
    };
    const metadata = analysis.metadata ? safeParse<Record<string, unknown>>(analysis.metadata) : {};
    const documentIds = Array.isArray(metadata.documentIds)
      ? (metadata.documentIds as string[])
      : undefined;
    const model = typeof metadata.model === "string" ? metadata.model : undefined;
    const extraInstructions =
      typeof metadata.extraInstructions === "string" ? metadata.extraInstructions : undefined;
    const controller = new AbortController();
    const active: ActiveRun = {
      analysisId: opts.analysisId,
      controllers: new Map([[opts.agentKey, controller]]),
      cancelled: false,
    };
    this.active.set(opts.analysisId, active);

    audit({
      actor: { id: opts.actorId },
      action: "analysis.agent.regenerate",
      target: { type: "analysis", id: opts.analysisId },
      metadata: {
        agentKey: opts.agentKey,
        projectId: analysis.projectId,
        persona: (() => {
          const p = getPersona(opts.agentKey);
          return { agentKey: opts.agentKey, name: p.name, role: p.role };
        })(),
      },
    });

    // Track only the *delta* tokens consumed by this regenerate so we can
    // commit them atomically via SQL increment instead of clobbering the row.
    const delta: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let outcome: "completed" | "failed" = "completed";
    let errorMessage: string | null = null;
    try {
      const result = await this.runOneAgent({
        analysisId: opts.analysisId,
        projectId: analysis.projectId,
        projectName: analysis.project.name,
        projectDescription: analysis.project.description,
        agentKey: opts.agentKey,
        documentIds,
        model,
        extraInstructions,
        signal: controller.signal,
        actorId: opts.actorId,
      });
      delta.promptTokens += result.usage.promptTokens;
      delta.completionTokens += result.usage.completionTokens;
      delta.totalTokens += result.usage.totalTokens;
      // Re-run synthesis using all currently-persisted findings.
      await this.runSynthesisAndPersist({
        analysisId: opts.analysisId,
        projectId: analysis.projectId,
        projectName: analysis.project.name,
        model,
        signal: controller.signal,
        accumulator: delta,
      });
      this.emitCompleted(opts.analysisId);
    } catch (err) {
      outcome = "failed";
      errorMessage = (err as Error).message;
      this.emit({
        analysisId: opts.analysisId,
        agentKey: opts.agentKey,
        type: "failed",
        status: "failed",
        errorMessage,
        ts: Date.now(),
      });
    } finally {
      // Atomic write — increments columns server-side so two concurrent
      // regenerates can't lose tokens to a read/modify/write race.
      await finalizeAnalysisDelta({
        id: opts.analysisId,
        status: outcome,
        delta,
        errorMessage,
      });
      audit({
        actor: { id: opts.actorId },
        action: "analysis.regenerate",
        target: { type: "analysis", id: opts.analysisId },
        metadata: {
          projectId: analysis.projectId,
          agentKey: opts.agentKey,
          tokensConsumed: delta.totalTokens,
          decision: outcome,
          errorMessage,
        },
      });
      this.active.delete(opts.analysisId);
    }
  }

  /**
   * #741 (Epic #727) — synchronous pre-flight for {@link resumeSkippedRepos}.
   * Mirrors {@link assertCanRegenerate} (cost cap, terminal state, no in-flight
   * run) and additionally loads the persisted skipped-repo list so the route can
   * short-circuit to an idempotent no-op when nothing was skipped. Throws
   * {@link CostCapExceededError} / {@link AnalysisNotRegeneratableError} — the
   * route translates these to 429 / 409.
   */
  async assertCanResumeRepos(analysisId: string): Promise<{
    analysis: NonNullable<Awaited<ReturnType<typeof prisma.analysis.findFirst>>>;
    skippedRepos: AnalysisSkippedRepo[];
  }> {
    await assertCanStartAnalysis();
    const analysis = await prisma.analysis.findFirst({
      where: { id: analysisId, deletedAt: null },
      include: { project: true },
    });
    if (!analysis) throw new Error(`Analysis ${analysisId} not found`);
    if ((analysis as { project: { status: string } }).project.status === "archived") {
      throw new Error("Project is archived");
    }
    if (!REGENERATABLE_STATUSES.has((analysis as { status: string }).status)) {
      throw new AnalysisNotRegeneratableError(analysisId, (analysis as { status: string }).status);
    }
    // Double-resume / resume-while-running guard: a live ActiveRun (an original
    // pipeline, a regenerate, or an in-flight resume) means the analysis is being
    // mutated — reject rather than corrupt it.
    if (this.active.has(analysisId)) {
      throw new AnalysisNotRegeneratableError(analysisId, "running");
    }
    const capability = await getAnalysisCapability(analysisId);
    return { analysis, skippedRepos: capability?.skippedRepos ?? [] };
  }

  /**
   * #741 (Epic #727) — re-run the agentic code agent for ONLY the connectors a
   * prior multi-repo run dropped for budget, MERGING their findings into the
   * existing analysis (append-mode `code` AgentResult rows), then re-running
   * synthesis so requirements reflect the merged finding set.
   *
   * The skipped set gets its OWN full token budget (that is the point — they were
   * skipped for lack of it). If the skipped set is itself too large to give every
   * repo the floor, it re-caps and persists the still-remaining skipped list
   * (the loop guard). On success the capability record's `skippedRepos` is
   * updated to whatever remains (usually empty ⇒ the `repos-skipped-budget`
   * reason clears and the banner action disappears).
   *
   * Concurrency: an `ActiveRun` is registered up-front (checked in
   * {@link assertCanResumeRepos}) so a second resume — or a regenerate — is
   * rejected while this one runs. Token totals are committed atomically via SQL
   * `increment` deltas, never read/modify/write.
   */
  async resumeSkippedRepos(opts: {
    analysisId: string;
    actorId: string;
  }): Promise<ResumeSkippedReposResult> {
    const { analysis: maybeAnalysis, skippedRepos } = await this.assertCanResumeRepos(
      opts.analysisId,
    );
    // Idempotent no-op: nothing was skipped (or it was already resumed).
    if (skippedRepos.length === 0) {
      return { resumed: [], remaining: [], noop: true };
    }
    const analysis = maybeAnalysis as typeof maybeAnalysis & {
      project: { name: string; description: string; status: string };
      projectId: string;
      metadata: string | null;
    };

    const controller = new AbortController();
    const active: ActiveRun = {
      analysisId: opts.analysisId,
      controllers: new Map([["code", controller]]),
      cancelled: false,
    };
    this.active.set(opts.analysisId, active);

    audit({
      actor: { id: opts.actorId },
      action: "analysis.repos.resume.start",
      target: { type: "analysis", id: opts.analysisId },
      metadata: {
        projectId: analysis.projectId,
        skippedCount: skippedRepos.length,
        connectorIds: skippedRepos.map((r) => r.connectorId),
      },
    });

    const delta: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let outcome: "completed" | "failed" = "completed";
    let errorMessage: string | null = null;
    const resumed: AnalysisSkippedRepo[] = [];
    let remaining: AnalysisSkippedRepo[] = [];
    try {
      // Only resume connectors that STILL exist — a repo deleted since the
      // original run can't be analyzed and simply drops off the skipped list.
      const live = await prisma.repoConnection.findMany({
        where: {
          id: { in: skippedRepos.map((r) => r.connectorId) },
          projectId: analysis.projectId,
          deletedAt: null,
        },
        select: { id: true, label: true },
      });
      const liveById = new Map(live.map((c) => [c.id, c] as const));
      const resumeConnectors = skippedRepos
        .filter((r) => liveById.has(r.connectorId))
        .map((r) => ({ id: r.connectorId, label: liveById.get(r.connectorId)!.label }));

      if (resumeConnectors.length > 0) {
        const metadata = analysis.metadata
          ? safeParse<Record<string, unknown>>(analysis.metadata)
          : {};
        let model = typeof metadata.model === "string" ? metadata.model : undefined;
        if (model === "force-sonnet") model = SONNET_MODEL_ID;
        else if (model === "force-haiku") model = HAIKU_MODEL_ID;
        const extraInstructions =
          typeof metadata.extraInstructions === "string" ? metadata.extraInstructions : undefined;

        // Reconstruct the agentic-run inputs from persisted state (requirements
        // from the document agent, deterministic affected-code + escalation).
        // #768 — the original run merged the operator's free-text new
        // requirements into the code agent's requirement set; a resumed repo must
        // be analysed against the SAME set or it would investigate less than its
        // siblings.
        const requirements = mergeRequirementSets(
          await this.extractRequirementsFromDocAgent(opts.analysisId),
          await extractNewRequirementCandidates(extraInstructions),
        );
        const affectedCode = await this.computeAffectedCode(
          opts.analysisId,
          analysis.projectId,
          extraInstructions,
        );
        const escalation = await this.computeEscalations(
          opts.analysisId,
          analysis.projectId,
          requirements,
        );

        // Give the skipped set its own full budget; re-cap if it still can't fit
        // every repo (loop guard — the leftovers are re-persisted as skipped).
        const { effectiveConnectors, effectiveBudget, skipped } = capConnectorsForBudget(
          resumeConnectors,
          resolveAgentTokenBudget(),
        );
        for (const connector of effectiveConnectors) {
          if (active.cancelled) break;
          const result = await this.runAgenticCodeAgent({
            analysisId: opts.analysisId,
            projectId: analysis.projectId,
            projectName: `${analysis.project.name} [repo: ${connector.label}]`,
            projectDescription: analysis.project.description,
            requirements,
            extraInstructions,
            model,
            signal: controller.signal,
            connectorId: connector.id,
            tokenBudget: effectiveBudget,
            affectedCode,
            escalation,
            // Merge — never clobber the original run's persisted code findings.
            persistMode: "append",
          });
          delta.promptTokens += result.usage.promptTokens;
          delta.completionTokens += result.usage.completionTokens;
          delta.totalTokens += result.usage.totalTokens;
          resumed.push({ connectorId: connector.id, label: connector.label });
        }
        remaining = skipped.map((c) => ({ connectorId: c.id, label: c.label }));

        // Re-run synthesis over the MERGED finding set so requirements reflect
        // the newly-analyzed repos.
        await this.runSynthesisAndPersist({
          analysisId: opts.analysisId,
          projectId: analysis.projectId,
          projectName: analysis.project.name,
          model,
          signal: controller.signal,
          accumulator: delta,
        });
      }

      // Update the persisted capability so the banner reflects what still
      // remains (usually nothing ⇒ the reason + action disappear).
      await this.updateCapabilitySkippedRepos(opts.analysisId, remaining);
      this.emitCompleted(opts.analysisId);
    } catch (err) {
      outcome = "failed";
      errorMessage = (err as Error).message;
      this.emit({
        analysisId: opts.analysisId,
        agentKey: "code",
        type: "failed",
        status: "failed",
        errorMessage,
        ts: Date.now(),
      });
    } finally {
      await finalizeAnalysisDelta({
        id: opts.analysisId,
        status: outcome,
        delta,
        errorMessage,
      });
      audit({
        actor: { id: opts.actorId },
        action: "analysis.repos.resume",
        target: { type: "analysis", id: opts.analysisId },
        metadata: {
          projectId: analysis.projectId,
          resumedCount: resumed.length,
          remainingCount: remaining.length,
          tokensConsumed: delta.totalTokens,
          decision: outcome,
          errorMessage,
        },
      });
      this.active.delete(opts.analysisId);
    }
    return { resumed, remaining, noop: false };
  }

  /**
   * #741 — rewrite the persisted capability's `skippedRepos` (and re-derive its
   * reasons) after a resume, then broadcast the fresh record. Best-effort — a
   * persistence hiccup never fails the resume.
   */
  private async updateCapabilitySkippedRepos(
    analysisId: string,
    remaining: AnalysisSkippedRepo[],
  ): Promise<void> {
    const capability = await getAnalysisCapability(analysisId);
    if (!capability) return;
    const next: AnalysisCapability = {
      ...capability,
      skippedRepos: remaining,
      reasons: deriveCapabilityReasons({ ...capability, skippedRepos: remaining }),
    };
    try {
      await persistAnalysisCapability(analysisId, next);
    } catch (err) {
      log.warn("Capability persist failed", { analysisId, error: (err as Error).message });
    }
    if (!this.deps.io) return;
    const event: AnalysisCapabilityEvent = { analysisId, capability: next, ts: Date.now() };
    try {
      this.deps.io.to(`analysis:${analysisId}`).emit("analysis:capability", event);
    } catch (err) {
      log.warn("Socket emit failed", { error: (err as Error).message });
    }
  }

  /** Cancel an in-flight analysis. Idempotent. */
  async cancel(analysisId: string, actorId: string): Promise<boolean> {
    const active = this.active.get(analysisId);
    if (!active) return false;
    active.cancelled = true;
    for (const c of active.controllers.values()) c.abort();
    audit({
      actor: { id: actorId },
      action: "analysis.cancel",
      target: { type: "analysis", id: analysisId },
    });
    return true;
  }

  /** Whether an analysis is currently in flight (test introspection). */
  isActive(analysisId: string): boolean {
    return this.active.has(analysisId);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async runPipeline(
    analysisId: string,
    projectName: string,
    projectDescription: string,
    agentKeys: AnalysisSpecialistAgentKey[],
    opts: StartAnalysisOptions,
    // Issue #855 (Epic #852) — the project's raw `databaseAwareAnalysis` column
    // value (untrusted; validated inside `resolveDatabaseAware`). Trailing +
    // optional so pre-#855 callers (and test harnesses driving `runPipeline`
    // directly with 5 args) keep working unmodified — an omitted value
    // resolves to the documented default (`auto`).
    databaseAwareAnalysisSetting?: string,
  ): Promise<void> {
    const totals: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    // Track specialist-agent outcomes so we can fail an analysis that LOOKS
    // complete but produced nothing because every specialist errored (e.g. a
    // bad model id 404ing on every call). Without this, the pipeline reports
    // `completed` with zero findings/requirements — a silent green that hides a
    // total failure. `firstAgentError` captures the first specialist error to
    // surface in the analysis row (the synthesis fallback never throws, so it
    // alone wouldn't reveal the cause).
    let specialistSucceeded = 0;
    let specialistFailed = 0;
    let firstAgentError: string | null = null;
    const recordAgentOutcome = (r: PromiseSettledResult<unknown>): void => {
      if (r.status === "fulfilled") {
        specialistSucceeded += 1;
      } else {
        // Aborts are handled by the dedicated cancellation path; don't count
        // them as failures here.
        const reason = r.reason as { name?: string; message?: string } | undefined;
        if (reason?.name === "AbortError") return;
        specialistFailed += 1;
        if (firstAgentError === null && reason?.message) firstAgentError = reason.message;
      }
    };
    const run: ActiveRun = {
      analysisId,
      controllers: new Map(),
      cancelled: false,
    };
    this.active.set(analysisId, run);

    // #239 — unified job-lifecycle start, broadcast on both `job:{analysisId}`
    // and `project:{projectId}` so the analysis page gets push-driven status.
    jobEvents.started("analysis", analysisId, opts.projectId, "Analysis started");

    // #110 — record an AgentRun for deterministic replay. Failures here
    // never block the analysis (audit-trail best-effort).
    const replayRunId = await startReplayRun({
      sessionId: analysisId,
      projectId: opts.projectId,
      kind: "analysis",
    }).catch(() => undefined);

    try {
      // Phase 1: Run document agent first (for requirement extraction),
      // then remaining agents. If code graph + requirements exist, the code
      // agent will run in agentic mode (#483).
      const hasDocAgent = agentKeys.includes("document");
      const hasCodeAgent = agentKeys.includes("code");
      const nonSequencedKeys = agentKeys.filter((k) =>
        hasDocAgent && hasCodeAgent ? k !== "document" && k !== "code" : true,
      );
      const needsSequencing = hasDocAgent && hasCodeAgent;

      // #733 — seed the capability tracker from project-level facts + which
      // agents this run requested. Mutated below as the run resolves the code
      // agent mode, uses quarantine fallback, or skips repos for budget; then
      // finalized + persisted + emitted at completion.
      const capability = createCapabilityTracker({
        static: await detectStaticCapability(opts.projectId),
        codeAnalysisRequested: hasCodeAgent,
        databaseAnalysisRequested: agentKeys.includes("database"),
      });
      this.capabilities.set(analysisId, capability);

      let extractedRequirements: Array<{ id: string; text: string }> = [];
      // #824 — the run's AFFECTED SCHEMA block, hoisted so the Phase-2 synthesis
      // call (below the sequenced/non-sequenced branches) can reconcile code +
      // schema findings. Undefined ⇒ the synthesis prompt is byte-identical.
      let runAffectedSchemaBlock: string | undefined;

      // If sequencing needed, run document agent first
      if (needsSequencing) {
        const docController = new AbortController();
        run.controllers.set("document", docController);
        try {
          const docResult = await this.runOneAgent({
            analysisId,
            projectId: opts.projectId,
            projectName,
            projectDescription,
            agentKey: "document",
            documentIds: opts.documentIds,
            model: opts.model,
            extraInstructions: opts.extraInstructions,
            signal: docController.signal,
            replayRunId,
            actorId: opts.startedById,
          });
          totals.promptTokens += docResult.usage.promptTokens;
          totals.completionTokens += docResult.usage.completionTokens;
          totals.totalTokens += docResult.usage.totalTokens;
          recordAgentOutcome({ status: "fulfilled", value: docResult });
          // Extract requirements from document agent output
          extractedRequirements = await this.extractRequirementsFromDocAgent(analysisId);
        } catch (err) {
          if ((err as { name?: string }).name === "AbortError" && run.cancelled) {
            // Will be handled below in the cancellation check
          }
          recordAgentOutcome({ status: "rejected", reason: err });
          // Document agent failure is non-fatal for sequencing; code runs single-shot
        }
      }

      if (!run.cancelled) {
        // #768 — the operator's free-text "new requirements" are FIRST-CLASS
        // requirements, not just prompt garnish. Parse them with the same
        // deterministic, LLM-free splitter #735 uses and merge them (as `NR-*`
        // ids, de-duplicated against the document set) into the requirement set
        // the code agent works from. Without this, a project whose documents are
        // not requirement-bearing collapsed to `single-shot` and the user's brand
        // new requirement was never analysed against the code — the headline use
        // case, silently dormant.
        const extraction = await extractNewRequirementCandidatesWithAccount(opts.extraInstructions);
        const newRequirements = extraction.candidates;
        const mergeResult = mergeRequirementSetsWithAccount(extractedRequirements, newRequirements);
        const codeRequirements = mergeResult.requirements;

        // #1112 (Epic #1107) — INPUT-side coverage. `RequirementCoverage` grades
        // outputs, so a requirement sliced off by the candidate cap (#1101's R7)
        // was unobservable by construction: the raw text never reaches synthesis
        // and there was nothing left downstream to notice its absence. Account for
        // every parsed block here, at the only point where all three stages
        // (truncation, cap, de-dupe) are still visible, and hang it on the
        // capability record the results page already renders.
        const hasFreeTextRequirements = (opts.extraInstructions?.trim().length ?? 0) > 0;
        if (hasFreeTextRequirements) {
          capability.requirementInputAccount = buildRequirementInputAccount(
            extraction,
            mergeResult,
          );
        }

        // Determine if code agent should run agentic
        const codeAgentMode = hasCodeAgent
          ? await this.detectAgentMode(opts.projectId, "code", codeRequirements)
          : "single-shot";

        // #733 — record the resolved code agent mode and warn the UI early (the
        // banner can render mid-run, not only after completion).
        if (hasCodeAgent) {
          capability.agentMode = codeAgentMode;
          // #768 — separate "your documents had no requirements" from "you gave us
          // requirements and we DID analyse them against code".
          capability.newRequirementsProvided = hasFreeTextRequirements;
          capability.newRequirementsAnalyzed =
            newRequirements.length > 0 && codeAgentMode !== "single-shot";
          this.emitCapability(analysisId, capability);
        } else if (hasFreeTextRequirements) {
          // #1112 — a discarded input is the USER's loss, not the code agent's, so
          // it must reach the UI even on a run with no code agent selected.
          this.emitCapability(analysisId, capability);
        }

        // #735 (Epic #726) — compute the deterministic requirement→code mapping
        // for the operator's free-text new requirements ONCE per run (it is
        // project-scoped, so it is identical across multi-repo connectors), then
        // persist it for the UI and thread its fenced block into the code
        // agent's gap prompt. A clean no-op when disabled, no new requirements
        // were supplied, or no candidates parsed — never throws.
        //
        // #768 — NOT gated on `codeAgentMode` any more. The mapping is
        // deterministic, cheap and is precisely what the operator asked for; it
        // must not depend on the mode the agent happened to land in (which, before
        // #768, depended on requirements the operator never supplied). Empty
        // `extraInstructions` still short-circuits inside `computeAffectedCode`.
        const affectedCode = hasCodeAgent
          ? await this.computeAffectedCode(analysisId, opts.projectId, opts.extraInstructions)
          : EMPTY_AFFECTED_CODE_CONTEXT;

        // #824 (Epic #820 Phase 1) — the deterministic AFFECTED SCHEMA block,
        // computed ONCE per run (project-scoped, identical across connectors) and
        // threaded into Sally (database), the code agent, and synthesis so they
        // reason about schema changes with reconciled, TEXT-ONLY suggested DDL.
        //
        // #855 (Epic #852 Phase 2b) — whether it runs is now governed by the
        // per-project `databaseAwareAnalysis` setting via #854's resolver, NOT
        // the bare `ANALYSIS_AFFECTED_SCHEMA_MAPPING` env flag directly: the
        // resolver folds the setting + schema-data presence into ONE decision
        // and `computeAffectedSchema` is handed the resolved `enabled` (the env
        // flag remains only the fallback `computeRunAffectedSchemaContext` reads
        // when `enabled` is left undefined — never reached once a decision is
        // resolved here). The applicability condition is unchanged: only
        // meaningful when the code or database agent is part of this run. The
        // resolved decision + reason are persisted on analysis metadata
        // (`metadata.databaseAware`) so a resolved-OFF or
        // resolved-ON-but-no-schema-data run is an observable skip, never a
        // silent no-op.
        const dbAwareApplicable = hasCodeAgent || agentKeys.includes("database");
        const dbAware = dbAwareApplicable
          ? await this.resolveDatabaseAware(
              analysisId,
              opts.projectId,
              databaseAwareAnalysisSetting,
            )
          : null;
        const affectedSchema = dbAwareApplicable
          ? await this.computeAffectedSchema(
              analysisId,
              opts.projectId,
              opts.extraInstructions,
              dbAware?.enabled,
            )
          : EMPTY_AFFECTED_SCHEMA_CONTEXT;
        // #824 — expose the block to the Phase-2 synthesis call (out of this scope).
        runAffectedSchemaBlock = affectedSchema.block || undefined;

        // #739 (Epic #727) — score each extracted requirement for ambiguity +
        // impact and route high scorers to a deeper multi-hop agentic pass.
        // Computed ONCE per run (project-scoped, identical across connectors),
        // persisted for the UI, then threaded into every agentic code pass.
        // Only meaningful in agentic mode (the requirement-grounded path has no
        // tool loop). Undefined when the policy is disabled (default) ⇒ the
        // agentic pass keeps today's uniform depth. Never throws.
        const escalation =
          hasCodeAgent && codeAgentMode === "agentic"
            ? await this.computeEscalations(analysisId, opts.projectId, codeRequirements)
            : undefined;

        // Run remaining agents in parallel
        const parallelKeys = needsSequencing
          ? [...nonSequencedKeys]
          : [...agentKeys.filter((k) => k !== "code" || codeAgentMode === "single-shot")];

        // Add code agent to parallel if single-shot mode and not yet sequenced
        if (hasCodeAgent && codeAgentMode === "single-shot" && needsSequencing) {
          parallelKeys.push("code");
        }

        const parallelSettled = await Promise.allSettled(
          parallelKeys.map(async (agentKey) => {
            const controller = new AbortController();
            run.controllers.set(agentKey, controller);
            return this.runOneAgent({
              analysisId,
              projectId: opts.projectId,
              projectName,
              projectDescription,
              agentKey,
              documentIds: opts.documentIds,
              model: opts.model,
              extraInstructions: opts.extraInstructions,
              signal: controller.signal,
              replayRunId,
              actorId: opts.startedById,
              // #824 — Sally (database) renders it; other specialists ignore it.
              affectedSchema: affectedSchema.block || undefined,
            });
          }),
        );

        for (const r of parallelSettled) {
          recordAgentOutcome(r);
          if (r.status === "fulfilled") {
            totals.promptTokens += r.value.usage.promptTokens;
            totals.completionTokens += r.value.usage.completionTokens;
            totals.totalTokens += r.value.usage.totalTokens;
          }
        }

        // Run agentic code agent if applicable
        if (hasCodeAgent && codeAgentMode === "agentic" && !run.cancelled) {
          const codeController = new AbortController();
          run.controllers.set("code", codeController);
          // Find ALL connectors for the project (multi-repo support, epic #663/#668)
          const connectors = await prisma.repoConnection.findMany({
            where: { projectId: opts.projectId, deletedAt: null },
            select: { id: true, label: true },
          });
          try {
            if (connectors.length <= 1) {
              // Single-repo (or none) — original behavior
              const codeResult = await this.runAgenticCodeAgent({
                analysisId,
                projectId: opts.projectId,
                projectName,
                projectDescription,
                requirements: codeRequirements,
                extraInstructions: opts.extraInstructions,
                model: opts.model,
                signal: codeController.signal,
                connectorId: connectors[0]?.id,
                affectedCode,
                affectedSchema,
                escalation,
              });
              totals.promptTokens += codeResult.usage.promptTokens;
              totals.completionTokens += codeResult.usage.completionTokens;
              totals.totalTokens += codeResult.usage.totalTokens;
            } else {
              // Multi-repo — run agent per connector sequentially, split token
              // budget. When the even split falls below the per-repo floor the
              // shared capper truncates the list and hands the survivors a larger
              // budget; the dropped connectors are surfaced + persisted (#741) so
              // the UI can name them and offer the resume action — not silently
              // dropped as a bare `log.warn` (#727 epic AC).
              const { effectiveConnectors, effectiveBudget, skipped } = capConnectorsForBudget(
                connectors,
                resolveAgentTokenBudget(),
              );
              if (skipped.length > 0) {
                log.warn("Multi-repo token budget below minimum per repo; capping repo count", {
                  analysisId,
                  totalRepos: connectors.length,
                  analyzedRepos: effectiveConnectors.length,
                  skippedRepos: skipped.length,
                  effectiveBudget,
                  minRequired: MIN_PER_REPO_TOKEN_BUDGET,
                });
                // #741 — record repos dropped for budget so the UI can name them
                // and the resume endpoint can re-run only those connectors.
                for (const c of skipped) {
                  capability.skippedRepos.push({ connectorId: c.id, label: c.label });
                }
                // Surface the cap immediately (mid-run) via a structured event +
                // a fresh capability push — the banner + resume action can render
                // before the run completes.
                this.emitReposSkipped(analysisId, capability.skippedRepos);
                this.emitCapability(analysisId, capability);
              }
              const multiResults: AgentRunResult[] = [];
              for (const connector of effectiveConnectors) {
                if (run.cancelled) break;
                const result = await this.runAgenticCodeAgent({
                  analysisId,
                  projectId: opts.projectId,
                  projectName: `${projectName} [repo: ${connector.label}]`,
                  projectDescription,
                  requirements: codeRequirements,
                  extraInstructions: opts.extraInstructions,
                  model: opts.model,
                  signal: codeController.signal,
                  connectorId: connector.id,
                  tokenBudget: effectiveBudget,
                  affectedCode,
                  affectedSchema,
                  escalation,
                });
                multiResults.push(result);
                totals.promptTokens += result.usage.promptTokens;
                totals.completionTokens += result.usage.completionTokens;
                totals.totalTokens += result.usage.totalTokens;
              }
            }
          } catch (err) {
            if ((err as { name?: string }).name !== "AbortError") {
              log.error("Agentic code agent failed", { analysisId, error: (err as Error).message });
            }
            // Count the agentic code agent's failure so the all-failed gate
            // (`specialistSucceeded === 0 && specialistFailed > 0`) sees it.
            // `recordAgentOutcome` ignores AbortError reasons internally.
            recordAgentOutcome({ status: "rejected", reason: err });
          }
        }

        // Run requirement-grounded code agent when requirements exist but no
        // code graph is present (Epic #912 / #916). Grounds findings in the
        // user's selected documents instead of degrading to static queries.
        if (hasCodeAgent && codeAgentMode === "requirement-grounded" && !run.cancelled) {
          const codeController = new AbortController();
          run.controllers.set("code", codeController);
          try {
            const codeResult = await this.runRequirementGroundedCodeAgent({
              analysisId,
              projectId: opts.projectId,
              projectName,
              projectDescription,
              requirements: codeRequirements,
              documentIds: opts.documentIds,
              extraInstructions: opts.extraInstructions,
              model: opts.model,
              signal: codeController.signal,
              affectedCode,
              affectedSchema,
            });
            totals.promptTokens += codeResult.usage.promptTokens;
            totals.completionTokens += codeResult.usage.completionTokens;
            totals.totalTokens += codeResult.usage.totalTokens;
          } catch (err) {
            if ((err as { name?: string }).name !== "AbortError") {
              log.error("Requirement-grounded code agent failed", {
                analysisId,
                error: (err as Error).message,
              });
            }
            // Count the requirement-grounded code agent's failure so the
            // all-failed gate sees it. `recordAgentOutcome` ignores AbortError
            // reasons internally.
            recordAgentOutcome({ status: "rejected", reason: err });
          }
        }
      }

      // Non-sequenced path (backward compat when doc+code don't both exist)
      if (!needsSequencing && !run.cancelled) {
        const settled = await Promise.allSettled(
          agentKeys.map(async (agentKey) => {
            if (run.controllers.has(agentKey))
              return {
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              } as AgentRunResult;
            const controller = new AbortController();
            run.controllers.set(agentKey, controller);
            return this.runOneAgent({
              analysisId,
              projectId: opts.projectId,
              projectName,
              projectDescription,
              agentKey,
              documentIds: opts.documentIds,
              model: opts.model,
              extraInstructions: opts.extraInstructions,
              signal: controller.signal,
              replayRunId,
              actorId: opts.startedById,
              // #824 — Sally (database) renders it; other specialists ignore it.
              // `runAffectedSchemaBlock` is the hoisted string form; the
              // `affectedSchema` object is scoped to the `!run.cancelled` block above.
              affectedSchema: runAffectedSchemaBlock,
            });
          }),
        );

        for (const r of settled) {
          recordAgentOutcome(r);
          if (r.status === "fulfilled") {
            totals.promptTokens += r.value.usage.promptTokens;
            totals.completionTokens += r.value.usage.completionTokens;
            totals.totalTokens += r.value.usage.totalTokens;
          }
        }
      }

      // Epic #260 (#81) — run custom agents ENABLED for this project alongside
      // the built-in specialists. Best-effort: per-agent failures are isolated
      // inside the phase and never abort the analysis. Token usage is folded
      // into the run totals so budget accounting stays accurate.
      if (!run.cancelled) {
        const customController = new AbortController();
        run.controllers.set("custom-agents", customController);
        try {
          const customPhase = await runEnabledCustomAgents({
            provider: this.deps.provider,
            projectId: opts.projectId,
            projectName,
            projectDescription,
            signal: customController.signal,
          });
          totals.promptTokens += customPhase.usage.promptTokens;
          totals.completionTokens += customPhase.usage.completionTokens;
          totals.totalTokens += customPhase.usage.totalTokens;
          if (customPhase.results.length > 0) {
            log.info("Custom agents ran during analysis", {
              analysisId,
              count: customPhase.results.length,
              failed: customPhase.results.filter((r) => r.error).length,
            });
          }
        } catch (err) {
          // Phase wrapper should never throw, but never let it sink the run.
          log.warn("Custom-agent phase failed", {
            analysisId,
            error: (err as Error).message,
          });
        }
      }

      if (run.cancelled) {
        await markAnalysisCancelled(analysisId, totals);
        this.emitCancelled(analysisId);
        // #239 — a cancelled run is terminal; report as failed on the unified
        // job channel so the UI leaves the running state (with a clear reason).
        jobEvents.failed("analysis", analysisId, opts.projectId, "Analysis cancelled");
        audit({
          actor: { id: opts.startedById },
          action: "analysis.cancelled",
          target: { type: "analysis", id: analysisId },
          metadata: { tokens: totals.totalTokens },
        });
        if (replayRunId) {
          // A cancelled analysis may still have incurred spend before the
          // cancel landed; attribute whatever usage is in-window.
          const { costCents } = await computeReplayRunCost(replayRunId).catch(() => ({
            costCents: 0,
          }));
          await finishReplayRun({
            runId: replayRunId,
            status: "cancelled",
            totalTokens: totals.totalTokens,
            costCents,
          }).catch(() => undefined);
        }
        return;
      }

      // Epic #922 — opt-in requirements enhancement (web research +
      // clarification prep). Runs after agents, before synthesis. Cost-gated
      // (skipped unless a flag is on) and fully offline-safe.
      if (!run.cancelled && (opts.enableWebResearch || opts.enableClarification)) {
        const enhanceController = new AbortController();
        run.controllers.set("enhancement", enhanceController);
        await this.runEnhancementPipeline({
          analysisId,
          extractedRequirements,
          extraInstructions: opts.extraInstructions,
          enableWebResearch: opts.enableWebResearch ?? false,
          enableClarification: opts.enableClarification ?? false,
          model: opts.model,
          signal: enhanceController.signal,
        }).catch((err) => {
          // Enhancement is best-effort — never fail the analysis over it.
          log.error("Enhancement pipeline failed", {
            analysisId,
            error: (err as Error).message,
          });
        });
      }

      // Honesty gate (#anthropic-model-id-and-analysis-status): if EVERY
      // specialist agent that ran failed (none succeeded) and at least one real
      // error was recorded, the run produced no findings — synthesis only ever
      // falls back to a deterministic, evidence-free merge. Reporting that as
      // `completed` is a silent green that masks a total failure (e.g. an
      // invalid model id 404ing on every agent). Mark it `failed` instead and
      // surface the first agent error so operators see the cause. Partial
      // success (≥1 specialist succeeded) stays `completed` — degraded output is
      // still useful and the happy path is untouched.
      if (specialistSucceeded === 0 && specialistFailed > 0) {
        const summary = `All ${specialistFailed} specialist agent(s) failed; no findings were produced.${
          firstAgentError ? ` First error: ${firstAgentError}` : ""
        }`;
        log.error("All specialist agents failed; marking analysis failed", {
          analysisId,
          specialistFailed,
          firstAgentError,
        });
        await markAnalysisFailed(analysisId, summary, totals);
        this.emitFailed(analysisId, genericFailureMessage("analysis"));
        jobEvents.failed("analysis", analysisId, opts.projectId, genericFailureMessage("analysis"));
        audit({
          actor: { id: opts.startedById },
          action: "analysis.failed",
          target: { type: "analysis", id: analysisId },
          metadata: { error: summary, agentCount: agentKeys.length },
        });
        if (replayRunId) {
          const { costCents } = await computeReplayRunCost(replayRunId).catch(() => ({
            costCents: 0,
          }));
          await finishReplayRun({
            runId: replayRunId,
            status: "failed",
            totalTokens: totals.totalTokens,
            costCents,
          }).catch(() => undefined);
        }
        return;
      }

      // Phase 2: synthesis.
      const synthController = new AbortController();
      run.controllers.set("synthesis", synthController);
      const synthesisOutcome = await this.runSynthesisAndPersist({
        analysisId,
        projectId: opts.projectId,
        projectName,
        model: opts.model,
        signal: synthController.signal,
        accumulator: totals,
        // #824 — reconcile code + schema findings per requirement when present.
        affectedSchema: runAffectedSchemaBlock,
      });

      // #733 — freeze + persist the capability record and push the final state
      // to the UI. Best-effort: a persistence hiccup must never fail a run that
      // otherwise completed.
      await this.finalizeAndPersistCapability(analysisId);

      await markAnalysisCompleted(analysisId, totals);
      this.emitCompleted(analysisId);
      // Issue #1104 (finding B) — when the approval gate withheld this run's
      // requirements, say so on the completion event. A run that produced
      // nothing the user can see must not read as plain success.
      const gate = synthesisOutcome?.promotionBlocked;
      const completionMessage = gate
        ? `Analysis complete — ${gate.awaitingRequirementCount} requirement(s) awaiting approval before they are saved`
        : "Analysis complete";
      jobEvents.completed("analysis", analysisId, opts.projectId, completionMessage);
      // Issue #67 — best-effort one-way Teams notification card. Fire-and-forget
      // off the critical path: a notification failure (or no configured target)
      // must never affect the completed analysis. The hook derives the workspace
      // from the project and no-ops when none is registered/installed.
      void notifyAnalysisComplete({ analysisId, projectId: opts.projectId });
      audit({
        actor: { id: opts.startedById },
        action: "analysis.complete",
        target: { type: "analysis", id: analysisId },
        metadata: {
          tokens: totals.totalTokens,
          agentCount: agentKeys.length,
          // #1104 — an audit trail that says "completed" for a run whose output
          // was withheld is the same lie as the UI's.
          ...(gate ? { awaitingApproval: gate.awaitingRequirementCount } : {}),
        },
      });
      if (replayRunId) {
        // Attribute real LLM cost from in-window TokenUsage rows for this run.
        const { costCents } = await computeReplayRunCost(replayRunId).catch(() => ({
          costCents: 0,
        }));
        await finishReplayRun({
          runId: replayRunId,
          status: "completed",
          totalTokens: totals.totalTokens,
          costCents,
        }).catch(() => undefined);
      }
    } catch (err) {
      // #254 — the RAW error is kept server-side only: logged at error level
      // here and persisted to the analysis row. Both client-facing socket events
      // (`analysis:failed` and the unified `job:lifecycle` `failed` event) carry
      // only a generic, user-safe message. The `analysis:{id}` room is NOT an
      // authorized watcher gate — `subscribe:analysis` accepts any authenticated
      // socket — so the raw error must never be emitted on it either.
      log.error("Pipeline failed", { analysisId, error: (err as Error).message });
      await markAnalysisFailed(analysisId, (err as Error).message, totals);
      this.emitFailed(analysisId, genericFailureMessage("analysis"));
      jobEvents.failed("analysis", analysisId, opts.projectId, genericFailureMessage("analysis"));
      audit({
        actor: { id: opts.startedById },
        action: "analysis.failed",
        target: { type: "analysis", id: analysisId },
        metadata: { error: (err as Error).message },
      });
      if (replayRunId) {
        // A failed analysis may still have incurred spend before throwing;
        // attribute whatever usage landed in-window.
        const { costCents } = await computeReplayRunCost(replayRunId).catch(() => ({
          costCents: 0,
        }));
        await finishReplayRun({
          runId: replayRunId,
          status: "failed",
          totalTokens: totals.totalTokens,
          costCents,
        }).catch(() => undefined);
      }
    } finally {
      this.active.delete(analysisId);
      this.capabilities.delete(analysisId);
    }
  }

  /**
   * Epic #922 — opt-in requirements enhancement seam. Extracts structured
   * requirements (with ambiguities + evidence needs) from the document agent's
   * extracted requirements, optionally augments evidence needs via web
   * research, and persists both into analysis metadata for the clarification
   * dialog (#926) and evidence review UI (#927).
   *
   * Offline-safe by construction: when the provider is offline the extractor
   * cannot produce reliable JSON, so the entire path becomes a deterministic
   * no-op (no extraction, no web research, no network). Best-effort — callers
   * swallow failures so an enhancement error never fails the analysis.
   */
  private async runEnhancementPipeline(input: {
    analysisId: string;
    extractedRequirements: Array<{ id: string; text: string }>;
    extraInstructions?: string;
    enableWebResearch: boolean;
    enableClarification: boolean;
    model?: string;
    signal: AbortSignal;
    /** Epic #202 (#215) — override the approval policy; defaults to DEFAULT_APPROVAL_POLICY. */
    approvalPolicy?: ApprovalPolicy;
  }): Promise<void> {
    const provider = this.deps.provider;

    // Record the opt-in flags so the UI / e2e can observe what was requested,
    // independent of whether extraction yields anything.
    await persistAnalysisEnhancement(input.analysisId, {
      enhancement: {
        enableWebResearch: input.enableWebResearch,
        enableClarification: input.enableClarification,
      },
    });

    // Extraction requires an online provider — offline yields no structured
    // requirements, making the whole enhancement path a no-op.
    if (provider.offline) return;

    // Seed text for extraction. Prefer the document agent's structured
    // requirements, but those are frequently empty (the doc agent emits prose
    // findings without a populated `requirements[]` array). Fall back to the
    // persisted finding bodies — primarily the document agent's, then any
    // specialist's — so clarification + web research aren't silently gated on a
    // field the agent rarely fills. extraInstructions is always included.
    let seedTexts = input.extractedRequirements
      .map((r) => r.text)
      .filter((t) => t.trim().length > 0);
    if (seedTexts.length === 0) {
      const flat = await readFlattenedFindings(input.analysisId);
      const docFindings = flat.filter((f) => f.agentKey === "document");
      const source = docFindings.length > 0 ? docFindings : flat;
      seedTexts = source
        .map((f) => [f.title, f.body].filter(Boolean).join(". "))
        .filter((t) => t.trim().length > 0);
    }

    const rawInput = [input.extraInstructions?.trim() ?? "", ...seedTexts]
      .filter((s) => s.length > 0)
      .join("\n\n");
    if (rawInput.trim().length === 0) return;

    const extractor = new RequirementsExtractor({ provider, model: input.model });
    const structured = await extractor.extract(rawInput, input.signal);
    await persistAnalysisEnhancement(input.analysisId, { structuredRequirements: structured });

    // Epic #202 (#215) — HITL approval checkpoints. Create one approval request
    // per extracted requirement so a human must approve before artifacts are
    // promoted (gating happens in runSynthesisAndPersist, #216). Honours
    // DEFAULT_APPROVAL_POLICY: requirement approval is required by default.
    // Best-effort — never fail the enhancement over checkpoint creation.
    const approvalItems: Array<{ type: ApprovalType; itemId: string }> =
      structured.requirements.map((r) => ({ type: "requirement", itemId: r.id }));

    if (input.signal.aborted) return;

    // Web research — only when explicitly enabled and there is something to
    // research. Honours WEB_SEARCH_API_KEY via createSearchProvider() (stub
    // returns [] when no key, so this stays a no-op offline / unconfigured).
    if (input.enableWebResearch && structured.requirements.length > 0) {
      const augmenter = new WebResearchAugmenter({
        provider,
        searchProvider: createSearchProvider(),
        model: input.model,
      });
      const research = await augmenter.augment(structured.requirements, input.signal);
      await persistAnalysisEnhancement(input.analysisId, { webResearch: research });

      // Epic #202 (#215) — each evidence digest is a separate approval item so a
      // human can sign off on externally-sourced evidence before promotion.
      for (const digest of research.digests) {
        approvalItems.push({ type: "evidence", itemId: digest.id });
      }
    }

    // Persist the approval requests last so the itemId set reflects both
    // requirements and (when enabled) evidence digests in a single durable batch.
    if (approvalItems.length > 0) {
      await createApprovalRequests(input.analysisId, approvalItems, input.approvalPolicy);
    }
  }

  private async runOneAgent(input: {
    analysisId: string;
    projectId: string;
    projectName: string;
    projectDescription: string;
    agentKey: AnalysisSpecialistAgentKey;
    documentIds?: string[];
    model?: string;
    extraInstructions?: string;
    signal: AbortSignal;
    replayRunId?: string;
    /**
     * #732 — the actor who started/regenerated this analysis. Threaded through
     * so the DATABASE agent's schema-context introspection runs under the same
     * principal the connector authorises. Optional so callers that never reach
     * the schema branch (all non-database agents) stay unaffected.
     */
    actorId?: string;
    /**
     * #824 (Epic #820 Phase 1) — the deterministic AFFECTED SCHEMA block,
     * consumed ONLY by the database agent (Sally). Undefined for every other
     * agent so their prompts stay byte-identical.
     */
    affectedSchema?: string;
  }): Promise<AgentRunResult> {
    const startedAt = new Date();
    this.emit({
      analysisId: input.analysisId,
      agentKey: input.agentKey,
      type: "started",
      status: "running",
      ts: Date.now(),
    });
    return withInvokeAgentSpan(input.agentKey, async () => {
      try {
        const retrieved = await this.retrieveContext({
          analysisId: input.analysisId,
          projectId: input.projectId,
          agentKey: input.agentKey,
          documentIds: input.documentIds,
          projectName: input.projectName,
          projectDescription: input.projectDescription,
          extraInstructions: input.extraInstructions,
          actorId: input.actorId,
        });
        if (input.replayRunId) {
          await recordReplayStep({
            runId: input.replayRunId,
            kind: "agent_phase",
            content: { agentKey: input.agentKey, retrievedCount: retrieved.length },
          }).catch(() => undefined);
        }
        const result = await runAgent(this.deps.provider, {
          agentKey: input.agentKey,
          projectName: input.projectName,
          projectDescription: input.projectDescription,
          retrieved,
          signal: input.signal,
          extraInstructions: input.extraInstructions,
          // #824 — only the database agent (Sally) renders the AFFECTED SCHEMA
          // block; the builder ignores it for every other specialist.
          affectedSchema: input.agentKey === "database" ? input.affectedSchema : undefined,
          model:
            input.model ??
            (await this.selectModelForAgent(input.projectId, input.agentKey, retrieved)),
        });
        await persistAgentResult({
          analysisId: input.analysisId,
          agentKey: input.agentKey,
          status: "completed",
          output: result.output,
          startedAt,
          completedAt: new Date(),
          usage: result.usage,
        });
        if (input.replayRunId) {
          await recordReplayStep({
            runId: input.replayRunId,
            kind: "response",
            content: {
              agentKey: input.agentKey,
              findingCount: result.output.findings.length,
              usage: result.usage,
            },
            latencyMs: result.durationMs,
          }).catch(() => undefined);
        }
        this.emit({
          analysisId: input.analysisId,
          agentKey: input.agentKey,
          type: "completed",
          status: "completed",
          findingCount: result.output.findings.length,
          ts: Date.now(),
        });
        return result;
      } catch (err) {
        const aborted = (err as { name?: string }).name === "AbortError";
        const status: (typeof AGENT_RESULT_STATUSES)[number] = aborted ? "cancelled" : "failed";
        await persistAgentResult({
          analysisId: input.analysisId,
          agentKey: input.agentKey,
          status: aborted ? "cancelled" : "failed",
          output: null,
          startedAt,
          completedAt: new Date(),
          errorMessage: aborted ? "cancelled" : (err as Error).message,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        });
        this.emit({
          analysisId: input.analysisId,
          agentKey: input.agentKey,
          type: aborted ? "cancelled" : "failed",
          status,
          errorMessage: (err as Error).message,
          ts: Date.now(),
        });
        throw err;
      }
    });
  }

  /**
   * Determine the agent mode for a given agent key.
   *
   * Code agent (Epic #912 / #916):
   *   - `agentic` when a code graph exists AND requirements are available
   *     (multi-turn tool investigation).
   *   - `requirement-grounded` when requirements exist but no code graph —
   *     single-shot grounding over per-requirement retrieval. This is the key
   *     generalization: requirement-grounded findings run even without a graph
   *     instead of silently degrading to the static-query single-shot path.
   *   - `single-shot` otherwise (no requirements).
   *
   * #768 — "requirements" here means the MERGED set: document-extracted
   * requirements PLUS the candidates parsed from the operator's free-text new
   * requirements (`extraInstructions`). The caller merges; this function stays a
   * pure function of the set it is handed.
   */
  private async detectAgentMode(
    projectId: string,
    agentKey: AnalysisSpecialistAgentKey,
    requirements?: readonly RequirementRef[],
  ): Promise<AgentMode> {
    if (agentKey !== "code") return "single-shot";
    if (!requirements || requirements.length === 0) return "single-shot";
    const codeGraph = await prisma.codeGraph.findFirst({
      where: { projectId },
      select: { id: true },
      orderBy: { lastIndexedAt: "desc" },
    });
    return codeGraph ? "agentic" : "requirement-grounded";
  }

  /**
   * Run the code agent in agentic mode (#480, #483).
   * Uses the multi-turn loop with tool-calling to investigate each requirement.
   */
  private async runAgenticCodeAgent(input: {
    analysisId: string;
    projectId: string;
    projectName: string;
    projectDescription: string;
    requirements: Array<{ id: string; text: string }>;
    extraInstructions?: string;
    model?: string;
    signal: AbortSignal;
    connectorId?: string;
    tokenBudget?: number;
    /** #735 (Epic #726) — deterministic requirement→code mapping seeded into the gap prompt. */
    affectedCode?: AffectedCodeContext;
    /** #824 (Epic #820 Phase 1) — deterministic AFFECTED SCHEMA block seeded into the gap prompt. */
    affectedSchema?: AffectedSchemaContext;
    /** #739 (Epic #727) — per-requirement escalation decision + turn caps. */
    escalation?: RunEscalation;
    /**
     * #741 (Epic #727) — how to persist this pass's `code` AgentResult. Defaults
     * to `"replace"` (today's behaviour). The resume endpoint passes `"append"`
     * so a resumed connector's findings MERGE alongside the original run's code
     * findings instead of clobbering them.
     */
    persistMode?: "replace" | "append";
  }): Promise<AgentRunResult> {
    const startedAt = new Date();
    const agentKey = "code" as const;
    const affectedCode = input.affectedCode ?? EMPTY_AFFECTED_CODE_CONTEXT;
    const affectedSchema = input.affectedSchema ?? EMPTY_AFFECTED_SCHEMA_CONTEXT;
    this.emit({
      analysisId: input.analysisId,
      agentKey,
      type: "started",
      status: "running",
      ts: Date.now(),
    });

    return withInvokeAgentSpan(agentKey, async () => {
      try {
        // #777 — Determine the clone directory for the file tools by EXISTENCE, not by
        // the truthiness of a speculatively-built path string. One async stat per
        // agentic pass (never per turn, never per tool call). A connector whose clone
        // is not on disk ⇒ `undefined` ⇒ the file tools are withheld, the prompt says
        // so, and the run reports `repo-clone-unavailable` — instead of offering two
        // tools that are GUARANTEED to fail on every call, burning the turn budget,
        // and then branding its own (perfectly good) graph-grounded verdicts as
        // retrieval-degraded.
        const cloneDir = await resolveExistingCloneDir(input.connectorId);
        const fileToolsAvailable = cloneDir !== undefined;
        if (input.connectorId && !fileToolsAvailable) {
          // Not an error: a fully-indexed project can legitimately have no working
          // tree (clone reaped after ingest, ephemeral disk, redeploy, ingest-only).
          // The graph + symbol tools need no clone, so the run degrades to them.
          log.info("Repo clone unavailable; agentic code pass will run without file tools", {
            analysisId: input.analysisId,
            connectorId: input.connectorId,
            expectedPath: cloneDirPath(input.connectorId),
          });
          this.markRepoCloneUnavailable(input.analysisId);
        }
        // Withheld file tools are excluded from the #773 retrieval-health counters (see
        // REPO_FILE_TOOLS): an "Unknown tool" error against a capability we chose not
        // to offer says nothing about whether code retrieval works.
        const withheldTools = fileToolsAvailable ? NO_WITHHELD_TOOLS : REPO_FILE_TOOLS;

        // Build tool context
        const toolContext: ToolContext = {
          projectId: input.projectId,
          connectorId: input.connectorId,
          cloneDir,
        };

        // Assemble available tools. `search_code_symbols` (#730) rides the same
        // `fusedCode` searcher/line-lookup seam #729 uses for passive seeding, so
        // the passive seed and the agent's active follow-up queries hit one index.
        const knowledge = this.deps.knowledge ?? getKnowledgeService();

        // #1312 / #777 — `describe_table` is offered ONLY when the project has a
        // connector to introspect. Handing the agent a schema tool on a project
        // with no database would burn turns on calls that can only fail.
        // `actorId` is not threaded onto the code-agent path; the database branch
        // has the same gap and passes "" to this identical read-only introspector.
        const introspect = this.deps.schemaContext?.introspect ?? introspectProjectSchema;
        let describeTableDeps: DescribeTableDeps | undefined;
        try {
          const injected = this.deps.schemaContext !== undefined;
          if (injected || (await listDbConnectors(input.projectId)).length > 0) {
            describeTableDeps = { introspect: (projectId: string) => introspect(projectId, "") };
          }
        } catch {
          describeTableDeps = undefined;
        }

        const tools = assembleAgenticCodeTools({
          knowledgeService: knowledge,
          cloneDir,
          fusedCodeDeps: this.deps.fusedCode,
          describeTableDeps,
        });

        // #729 (Epic #725) — passively seed the agentic prompt with fused
        // code-graph symbol context BEFORE the tool loop, so the agent is
        // grounded in real source on turn 1 instead of spending a turn
        // discovering it (complementary to the search_code_symbols tool #730
        // adds). Env-gated ON by default (`ANALYSIS_FUSED_CODE_RETRIEVAL`, #752);
        // when an operator disables it this is a no-op and the prompt + budget are
        // byte-identical to today. The block is deduped against nothing here (no prior RAG chunks
        // on this path) and token-budgeted by `ANALYSIS_FUSED_CODE_TOKEN_BUDGET`.
        const fused = await retrieveFusedCodeContext({
          projectId: input.projectId,
          projectName: input.projectName,
          projectDescription: input.projectDescription,
          // #731 — fold operator notes into the source-code retrieval query so
          // the agentic path (where requirements ARE present) derives its symbol
          // search from requirements + `extraInstructions` + project metadata,
          // not requirements + metadata alone.
          extraInstructions: input.extraInstructions,
          requirements: input.requirements,
          ragChunks: [],
          deps: this.deps.fusedCode,
        });

        const agentBudget = input.tokenBudget ?? resolveAgentTokenBudget();
        // #774 — every tool call the loop makes, across every pass, so the run's
        // tool-call error counts can be persisted on the AgentResult. Before
        // #774 the loop's `toolCalls` were returned and DISCARDED here, which is
        // exactly why a run whose searches all failed looked like a normal run.
        const allToolCalls: ToolCallRecord[] = [];
        // #773 — per-pass retrieval health (the evidence threshold's input). Merged
        // into ONE run-level record so the capability reason + the gap report's
        // searched-scope provenance describe the whole run.
        const passHealths: AnalysisRetrievalHealth[] = [];
        const { extractJsonObject } = await import("./agent-runner.js");
        const { agentOutputSchema } = await import("@metis/shared");
        const onDrop = makeCitationDropLogger(input.analysisId, agentKey, "agentic");

        /**
         * #483/#734 — run ONE agentic loop over `passRequirements` with the given
         * turn cap and (pre-seed) token budget, returning the pass's grounded
         * output + usage.
         *
         * Both the fused block (#729) and the #735 affected-code block are seeded
         * into EVERY pass, so their token cost is carved OUT of each pass's budget
         * (never additive); the half-budget floor guards against an absurdly-large
         * combined seed and ensures the loop always keeps most of its budget.
         *
         * #734 — citations are grounded against the passive fused-symbol seed PLUS
         * every file the agent opened via tools and the deterministically-mapped
         * affected files (authoritative provenance the agent may cite without
         * re-opening). A locator never retrieved is dropped (anti-hallucination).
         *
         * #739 — deep passes call this with a higher turn cap and a proportional
         * slice of the budget (see {@link splitEscalationBudget}).
         */
        const runAgenticPass = async (
          passRequirements: Array<{ id: string; text: string }>,
          maxTurns: number,
          passBudget: number,
        ): Promise<{ output: AgentOutput; usage: TokenUsage }> => {
          const { systemMessage, userMessage } = buildAgenticCodePrompt({
            projectName: input.projectName,
            projectDescription: input.projectDescription,
            requirements: passRequirements,
            retrievedContext: fused.block || undefined,
            affectedCode: affectedCode.block || undefined,
            // #824 — the deterministic AFFECTED SCHEMA block (schema-change awareness).
            affectedSchema: affectedSchema.block || undefined,
            // #777 — tell the agent WHAT IT ACTUALLY HAS. Without this it plans around
            // reading files it can never open and spends turns discovering that.
            fileToolsAvailable,
          });
          const effectiveBudget = Math.max(
            Math.floor(passBudget / 2),
            passBudget - fused.tokens - affectedCode.tokens - affectedSchema.tokens,
          );
          // #1221 — resolved against the model this pass will actually run on
          // so the cap is clamped to that model's ceiling. `provider.model` is
          // the fallback because that is what the adapter uses when
          // `input.model` is unset.
          // #1257 — the retry this cap bounds is a `provider.chat` call, so it
          // is also bounded by the Anthropic SDK's non-streaming limit.
          const finalAnswerMaxOutputTokens = resolveFinalAnswerMaxOutputTokens(
            input.model ?? this.deps.provider.model,
            this.deps.provider.key,
          );
          const loopResult = await runAgentLoop(
            this.deps.provider,
            { systemMessage, userMessage, tools, toolContext },
            {
              maxTurns,
              maxTokens: effectiveBudget,
              signal: input.signal,
              model: input.model,
              promptCaching: { system: true, messages: true },
              // P0 #769 — when the loop runs out of turns/tokens mid-tool-call,
              // or answers in prose, spend ONE bounded tool-free call asking it
              // to serialize the investigation it has already done.
              finalAnswerRetry: {
                instruction: FINAL_ANSWER_INSTRUCTION,
                // #1314 — schema-aware, not shape-only: a JSON answer that fails
                // `agentOutputSchema` is exactly what this retry exists to fix.
                isValidFinalAnswer: isSchemaValidFinalAnswer,
                maxOutputTokens: finalAnswerMaxOutputTokens,
              },
            },
          );

          allToolCalls.push(...loopResult.toolCalls);

          // P0 #769 — honour what the loop reports instead of blindly parsing.
          // A pass that cannot be serialized DEGRADES (partial/empty findings +
          // an honest note + a capability reason); it never throws away the run.
          let validated: AgentOutput | undefined;
          let reason: AgenticDegradationReason | null = null;
          if (!loopResult.hasFinalAnswer) {
            // The loop (and its one bounded retry) never produced a JSON answer.
            reason = loopResult.budgetExhausted
              ? "token-budget"
              : loopResult.turnsExhausted
                ? "turn-limit"
                : // #1314 — `hasFinalAnswer` is schema-aware now, so a response
                  // that still parses as JSON failed the schema, not the parser.
                  isJsonFinalAnswer(selectSalvageSource(loopResult))
                  ? "schema-invalid"
                  : "non-json-response";
          } else {
            try {
              const parsed = extractJsonObject(loopResult.finalResponse);
              if (parsed && typeof parsed === "object") {
                (parsed as Record<string, unknown>).agentKey = agentKey;
              }
              validated = agentOutputSchema.parse(parsed);
            } catch {
              reason = "schema-invalid";
            }
          }
          if (!validated) {
            // #1217 — salvage from the RAW model text the loop preserved, never
            // from `finalResponse`: on a turn/token stop that has already been
            // replaced by deliberately brace-free prose, which could not yield
            // a finding under any circumstances. `salvageWithRepair` also spends
            // ONE bounded syntax-repair call when the preserved payload was cut
            // off mid-array by an output cap.
            const salvage = await salvageWithRepair(
              this.deps.provider,
              selectSalvageSource(loopResult),
              {
                agentKey,
                model: input.model,
                signal: input.signal,
                // #1218 — repair echoes the payload back, so its own cap must
                // clear the cap that produced it or it truncates in turn.
                maxOutputTokens: repairMaxOutputTokens(finalAnswerMaxOutputTokens),
              },
            );
            const salvaged = salvage.findings;
            log.warn("Agentic code pass degraded; salvaging investigation", {
              analysisId: input.analysisId,
              reason,
              turnsUsed: loopResult.turnsUsed,
              toolCalls: loopResult.toolCalls.length,
              retryAttempted: loopResult.finalAnswerRetry?.attempted ?? false,
              retrySucceeded: loopResult.finalAnswerRetry?.succeeded ?? false,
              salvagedFindings: salvaged.length,
              // #1217 — WHY salvage found what it found. Without these three,
              // every degraded run logged an undifferentiated `0`. #1218 splits
              // `repairParsed` out: a repair that came back unparseable and one
              // whose findings were all rejected need opposite fixes.
              salvageSourceKind: salvage.sourceKind,
              repairAttempted: salvage.repairAttempted,
              repairParsed: salvage.repairParsed,
              repairSucceeded: salvage.repairSucceeded,
              // #1314 — a total loss is the only case the source kind cannot
              // explain, and it was undiagnosable in production without this.
              ...(salvaged.length === 0
                ? { preview: selectSalvageSource(loopResult).slice(0, 300) }
                : {}),
              tokens: loopResult.usage.totalTokens,
            });
            this.markCodeAgentDegraded(input.analysisId);
            validated = buildDegradedAgentOutput({
              agentKey,
              reason: reason ?? "non-json-response",
              toolCalls: loopResult.toolCalls,
              salvaged,
            });
          }
          // #773 — did THIS pass's retrieval actually work? The two signals the
          // verdict needs are computed here: the searched-scope-backed evidence
          // threshold, and (#1236) `exhausted` — the loop ran out of turns/tokens,
          // so requirements it never reached are unknown, not absent. `exhausted`
          // is deliberately NOT `starved`: starvation means retrieval broke, and
          // routing budget cut-off through it downgraded every finding in the pass,
          // including the ones that cite exact files and line numbers.
          const { health: passHealth, claimIndex: passClaimIndex } = summarizeRetrievalEvidence({
            toolCalls: loopResult.toolCalls,
            requirementCount: passRequirements.length,
            exhausted: loopResult.turnsExhausted || loopResult.budgetExhausted,
            // The #729 passive seed returned real code chunks ⇒ the code index is
            // alive. Same evidence the single-shot path trusts below; it proves
            // retrieval WORKS, and it never licenses an absence claim.
            seedGrounded: fused.chunks.length > 0,
            // #777 — tools this pass never offered. A call to one of them is a model
            // mistake against a known capability limit, NOT evidence about retrieval.
            unavailableTools: withheldTools,
          });
          // RUN-LEVEL health: did retrieval work AT ALL on this pass? This gates
          // BOTH verdict directions (an `implemented` claim from a pass whose
          // searches all failed is as unfounded as an absence claim — and worse,
          // it silently closes a real gap).
          const passRetrievalHealthy = absenceIsConfirmable(passHealth);
          if (!passRetrievalHealthy) {
            log.warn("Agentic code pass cannot confirm a verdict: retrieval below threshold", {
              analysisId: input.analysisId,
              requirementCount: passRequirements.length,
              successfulSearches: passHealth.successfulSearches,
              erroredCalls: passHealth.erroredCalls,
              starved: passHealth.starved,
              exhausted: passHealth.exhausted === true,
            });
          }
          // The text of each requirement this pass investigated, so a finding's
          // absence claim can be checked against the searches that actually bore
          // ON THAT REQUIREMENT (the per-claim half of the evidence threshold).
          const passRequirementText = new Map(passRequirements.map((r) => [r.id, r.text]));
          // The requirement SET, so the matcher can tell a term that discriminates
          // this requirement from boilerplate every requirement carries.
          const passRequirementCorpus = passRequirements.map((r) => r.text);

          const codeProvenance = buildCodeProvenance(fused.chunks, [
            ...collectToolProvenance(loopResult.toolCalls),
            ...affectedCode.filePaths,
          ]);
          validated.findings = validated.findings.map((f) => {
            // #740 — capture THIS finding's drops locally (still forwarding to
            // the shared observability logger) so the verifier can tell "claimed
            // code, all of it dropped" from "made no code claim".
            const dropped: DroppedCitation[] = [];
            const citations = groundCodeCitations(f.citations, codeProvenance, {
              onDrop: (d) => {
                dropped.push(d);
                onDrop(d);
              },
            });
            // #773 — an absence claim is EITHER the model saying so outright, or
            // the classic "No evidence found for X" phrasing. Either way it may
            // only stand when this pass actually SEARCHED FOR THIS THING.
            const claimsAbsence =
              f.verdict === "gap-confirmed" || assertsAbsence({ title: f.title, body: f.body });
            // PER-CLAIM evidence threshold: what is this finding ABOUT, and did any
            // working CODE search bear on that? A pass-wide quota would be either
            // unreachable at scale or meaningless — a search for "rate limiting" says
            // nothing about whether commit-SHA baselining exists.
            //
            // The claim side is the REQUIREMENT's text and NOTHING ELSE. The finding's
            // title is model-authored, as are the queries, so admitting it would let
            // the model license its own gap by echoing a search it ran for some OTHER
            // requirement in this one's headline. A finding whose requirementId is
            // missing or unresolvable therefore has no claim text at all — and cannot
            // confirm a gap. (Known bound: this reconstructs search→requirement
            // attribution LEXICALLY after the fact. Attributing at ISSUE time — the
            // agent knows which requirement it is investigating when it calls the
            // tool — is the right long-term design; tracked as follow-up.)
            const requirementText = f.requirementId
              ? (passRequirementText.get(f.requirementId) ?? "")
              : "";
            const absenceConfirmable = absenceIsConfirmableForClaim({
              health: passHealth,
              evidence: passClaimIndex,
              requirementText,
              requirementCorpus: passRequirementCorpus,
              // #1236 — the second half of "did the loop reach this requirement?",
              // read only when the pass was cut short by its budget. These are the
              // citations that already survived #734 grounding, so a hallucinated
              // file path cannot buy an exhausted pass a verdict.
              hasGroundedCodeCitation: citations.some(isCodeCitation),
            });
            // #773 — the verdict: the model's claim, deterministically DOWNGRADED
            // when the evidence does not support it. Never upgraded.
            const verdict = gateFindingVerdict({
              modelVerdict: f.verdict ?? null,
              groundedCitations: citations,
              finding: { title: f.title, body: f.body, tags: f.tags },
              absenceConfirmable,
              retrievalHealthy: passRetrievalHealthy,
              // #826 — the run's reconciled AFFECTED SCHEMA (#823/#824): downgrade a
              // DDL claim the live schema cannot support. Empty ⇒ no-op (flag OFF).
              schemaEvidence: schemaEvidenceFromAffectedRows(affectedSchema.rows),
            });
            // #773 — the FLATTENING fix. The body (which the #742 gap report
            // renders verbatim as the gap narrative) keeps the agent's own words;
            // the assertive HEADLINE a BA actually reads is corrected, and the
            // severity is dropped to `info` so an unverifiable claim can never
            // out-rank a confirmed gap in any severity-ordered surface.
            const unverifiable = verdict === "could-not-verify";
            return {
              ...f,
              citations,
              title: unverifiable ? retitleUnverifiableFinding(f.title) : f.title,
              severity: unverifiable ? ("info" as const) : f.severity,
              verdict,
              verificationStatus: verifyFinding({
                groundedCitations: citations,
                droppedCitations: dropped,
                assertsAbsence: claimsAbsence,
                absenceConfirmable,
              }),
            };
          });
          // #19 — the REPORT-side coverage check, over the gated verdicts. A pass
          // that made one working search and then verified none of its requirements
          // clears the (deliberately scale-free) verdict threshold above, so without
          // this it was persisted as healthy and raised no banner. `passHealth` —
          // the record the verdicts read — is left untouched.
          const reportedHealth = assessInvestigationCoverage(passHealth, {
            unverifiedRequirements: countUnverifiedRequirements(
              validated.findings,
              passRequirements.map((r) => r.id),
            ),
          });
          if (reportedHealth.degraded && !passHealth.degraded) {
            log.warn("Agentic code pass investigated too little to report as healthy", {
              analysisId: input.analysisId,
              requirementCount: passRequirements.length,
              codeRetrievalCalls: reportedHealth.totalCalls,
              unverifiedRequirements: reportedHealth.unverifiedRequirements ?? 0,
              starved: reportedHealth.starved,
            });
          }
          passHealths.push(reportedHealth);
          // #1109 (Epic #1107) — the multi-lens support panel runs AFTER the
          // deterministic verifier above, never instead of it: cheap signal
          // first, expensive signal only where the cheap one structurally cannot
          // judge ("does this evidence BACK the claim?" vs "was it retrieved?").
          // It only ADDS a confidence label — no vote combination removes a
          // finding — and it cannot fail this pass. Flag off ⇒ zero provider
          // calls and the findings array is returned untouched.
          const agenticEvidence = collectPanelEvidence(fused.chunks, loopResult.toolCalls);
          const panelled = await applySupportPanel(
            this.deps.provider,
            validated.findings,
            agenticEvidence,
            { ...(input.signal ? { signal: input.signal } : {}) },
          );
          validated.findings = panelled.findings;
          // #1318 (Epic #1316) — the claim-level faithfulness METRIC, over the
          // SAME evidence the panel graded so the two graders can never disagree
          // about what "the run saw" meant. Strictly additive: it writes one new
          // optional field and touches neither `verificationStatus` nor
          // `supportPanel`, so a flag-off run is byte-identical to a pre-#1318
          // one and nothing downstream can gate on it. Flag off => no call.
          const scored = await applyFindingFaithfulness(
            this.deps.provider,
            validated.findings,
            agenticEvidence,
            { ...(input.signal ? { signal: input.signal } : {}) },
          );
          validated.findings = scored.findings;
          // Panel and metric spend are attributed to THIS agent's usage so they
          // land in the existing per-agent cost accounting rather than as
          // unexplained drift. Both are zero when their flags are off.
          return {
            output: validated,
            usage: sumTokenUsage(sumTokenUsage(loopResult.usage, panelled.usage), scored.usage),
          };
        };

        // #739 (Epic #727) — partition the run's requirements into the escalated
        // (deep) set and the standard set, then run each through its own focused
        // pass: the deep set with a higher turn cap. When the policy is off (or no
        // requirement escalated) this collapses to a SINGLE standard pass over all
        // requirements — byte-identical to pre-#739 (same turn cap, same full
        // budget). When split, the two passes divide the run's token budget
        // proportional to their requirement counts (summing EXACTLY to
        // `agentBudget`), so total spend NEVER exceeds today's budget — escalation
        // reallocates depth, it never grows spend.
        const deepIds = new Set(
          (input.escalation?.decisions ?? [])
            .filter((d) => d.depth === "deep")
            .map((d) => d.requirementId),
        );
        const deepReqs = input.requirements.filter((r) => deepIds.has(r.id));
        const standardReqs = input.requirements.filter((r) => !deepIds.has(r.id));
        // #773 — the turn cap scales with the number of requirements the pass must
        // actually investigate (see `resolveAgenticMaxTurns`), so an honest verdict
        // per requirement is fundable instead of structurally impossible. When the
        // #739 escalation policy is on it still owns the caps.
        const standardTurns =
          input.escalation?.policy.standardMaxTurns ??
          resolveAgenticMaxTurns(standardReqs.length || input.requirements.length);
        const deepTurns =
          input.escalation?.policy.deepMaxTurns ?? resolveAgenticMaxTurns(deepReqs.length);

        let mergedOutput: AgentOutput;
        let mergedUsage: TokenUsage;
        if (deepReqs.length > 0 && standardReqs.length > 0) {
          const { deepBudget, standardBudget } = splitEscalationBudget(
            agentBudget,
            deepReqs.length,
            standardReqs.length,
          );
          log.info("Escalation: running split deep/standard agentic passes", {
            analysisId: input.analysisId,
            deepCount: deepReqs.length,
            standardCount: standardReqs.length,
            deepTurns,
            standardTurns,
            deepBudget,
            standardBudget,
          });
          const deep = await runAgenticPass(deepReqs, deepTurns, deepBudget);
          const standard = await runAgenticPass(standardReqs, standardTurns, standardBudget);
          mergedOutput = {
            ...deep.output,
            findings: [...deep.output.findings, ...standard.output.findings],
          };
          mergedUsage = sumTokenUsage(deep.usage, standard.usage);
        } else if (deepReqs.length > 0) {
          // Every requirement escalated — a single deep pass over the full budget.
          const only = await runAgenticPass(deepReqs, deepTurns, agentBudget);
          mergedOutput = only.output;
          mergedUsage = only.usage;
        } else {
          // Nothing escalated (policy off / no high scorers) — today's behaviour.
          const only = await runAgenticPass(input.requirements, standardTurns, agentBudget);
          mergedOutput = only.output;
          mergedUsage = only.usage;
        }

        const result: AgentRunResult = {
          agentKey,
          output: mergedOutput,
          usage: mergedUsage,
          durationMs: Date.now() - startedAt.getTime(),
        };

        // #773 — fold this code pass's retrieval health into the run. A run whose
        // retrieval fell below the evidence threshold raises
        // `code-retrieval-degraded`, so the #733 banner can warn that "not found"
        // results are unreliable — the reported incident showed `reasons: []`.
        const runHealth = mergeRetrievalHealth(passHealths);
        if (runHealth) {
          this.recordRetrievalHealth(input.analysisId, runHealth);
        }

        // #774 — bounded tool-call telemetry (counts, per-tool error counts, a
        // capped sample of the model-facing error text). Never the full tool
        // results, never the argument values.
        const toolTelemetry = summarizeToolCalls(allToolCalls);
        if (toolTelemetry.errorCalls > 0) {
          log.warn("Agentic code run had failing tool calls", {
            analysisId: input.analysisId,
            totalCalls: toolTelemetry.totalCalls,
            errorCalls: toolTelemetry.errorCalls,
            byTool: toolTelemetry.byTool,
          });
        }

        await persistAgentResult({
          analysisId: input.analysisId,
          agentKey,
          status: "completed",
          output: result.output,
          startedAt,
          completedAt: new Date(),
          usage: result.usage,
          toolTelemetry,
          mode: input.persistMode ?? "replace",
          // #763 — scope the replace-delete to this connector so a multi-repo
          // run keeps EVERY connector's code findings, not just the last.
          connectorId: input.connectorId,
        });

        this.emit({
          analysisId: input.analysisId,
          agentKey,
          type: "completed",
          status: "completed",
          findingCount: result.output.findings.length,
          ts: Date.now(),
        });

        return result;
      } catch (err) {
        const aborted = (err as { name?: string }).name === "AbortError";
        await persistAgentResult({
          analysisId: input.analysisId,
          agentKey,
          status: aborted ? "cancelled" : "failed",
          output: null,
          startedAt,
          completedAt: new Date(),
          errorMessage: aborted ? "cancelled" : (err as Error).message,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          // #763 — keep the failure row scoped to its connector too, so a failed
          // connector's row replaces only its own prior attempt.
          connectorId: input.connectorId,
        });
        this.emit({
          analysisId: input.analysisId,
          agentKey,
          type: aborted ? "cancelled" : "failed",
          status: aborted ? "cancelled" : "failed",
          errorMessage: (err as Error).message,
          ts: Date.now(),
        });
        throw err;
      }
    });
  }

  /**
   * Run the code agent in requirement-grounded mode (Epic #912 / #916).
   *
   * Unlike the agentic path this needs no code graph: evidence is retrieved
   * per-requirement from the user's selected documents (honouring the document
   * selection), the model produces findings tagged with their `requirementId`,
   * and any requirement with zero evidence yields a synthetic severity=info
   * finding so gaps are never silently dropped. The fan-out is bounded
   * (`MAX_REQUIREMENTS_FOR_RETRIEVAL`) and concurrency-capped
   * (`REQUIREMENT_RETRIEVAL_CONCURRENCY`); all evidence text is escaped through
   * the prompt builder's `escapeContext`, and the path is offline-safe (no
   * tool loop, single completion).
   */
  private async runRequirementGroundedCodeAgent(input: {
    analysisId: string;
    projectId: string;
    projectName: string;
    projectDescription: string;
    requirements: Array<{ id: string; text: string }>;
    documentIds?: string[];
    extraInstructions?: string;
    model?: string;
    signal: AbortSignal;
    /** #735 (Epic #726) — deterministic requirement→code mapping seeded into the gap prompt. */
    affectedCode?: AffectedCodeContext;
    /** #824 (Epic #820 Phase 1) — deterministic AFFECTED SCHEMA block seeded into the gap prompt. */
    affectedSchema?: AffectedSchemaContext;
  }): Promise<AgentRunResult> {
    const startedAt = new Date();
    const agentKey = "code" as const;
    const affectedCode = input.affectedCode ?? EMPTY_AFFECTED_CODE_CONTEXT;
    const affectedSchema = input.affectedSchema ?? EMPTY_AFFECTED_SCHEMA_CONTEXT;
    this.emit({
      analysisId: input.analysisId,
      agentKey,
      type: "started",
      status: "running",
      ts: Date.now(),
    });

    return withInvokeAgentSpan(agentKey, async () => {
      try {
        const knowledge = this.deps.knowledge ?? getKnowledgeService();

        // Honour the user's document selection (#913); fall back to all ready,
        // user-uploaded (non-connector) docs when nothing is selected.
        let documentIds = input.documentIds ?? [];
        if (documentIds.length === 0) {
          const uploadedDocs = await prisma.document.findMany({
            where: {
              projectId: input.projectId,
              deletedAt: null,
              status: "ready",
              filename: { not: { startsWith: "connector:" } },
            },
            select: { id: true },
          });
          documentIds = uploadedDocs.map((d) => d.id);
        }

        // Per-requirement retrieval — bounded fan-out, concurrency-capped.
        const perRequirement = await retrievePerRequirement(knowledge, {
          projectId: input.projectId,
          requirements: input.requirements,
          documentIds: documentIds.length > 0 ? documentIds : undefined,
          k: ANALYSIS_RETRIEVE_K,
          maxRequirements: MAX_REQUIREMENTS_FOR_RETRIEVAL,
          concurrency: REQUIREMENT_RETRIEVAL_CONCURRENCY,
        });

        // #729 (Epic #725) — fold fused code-graph symbol context into the
        // grounded evidence. This mode runs when NO code graph exists, so fused
        // retrieval will typically no-op ([] chunks, "" block); it is wired for
        // flag consistency and degrades cleanly. Env-gated ON by default (#752).
        const fused = await retrieveFusedCodeContext({
          projectId: input.projectId,
          projectName: input.projectName,
          projectDescription: input.projectDescription,
          extraInstructions: input.extraInstructions,
          requirements: input.requirements,
          ragChunks: perRequirement.flatMap((r) => r.chunks).map((c) => ({ filename: c.filename })),
          deps: this.deps.fusedCode,
        });

        // All retrieved chunks across requirements PLUS the fused symbol chunks,
        // for citation enrichment (so a model citing a code-graph symbol resolves
        // its filePath provenance).
        const allChunks: RetrievalContextChunk[] = [
          ...perRequirement.flatMap((r) => r.chunks),
          ...fused.chunks,
        ];

        // Build the grounded prompt (evidence escaped inside the builder).
        const { systemMessage, userMessage } = buildRequirementGroundedPrompt({
          projectName: input.projectName,
          projectDescription: input.projectDescription,
          extraInstructions: input.extraInstructions,
          codeContext: fused.block || undefined,
          affectedCode: affectedCode.block || undefined,
          // #824 — the deterministic AFFECTED SCHEMA block (schema-change awareness).
          affectedSchema: affectedSchema.block || undefined,
          requirements: perRequirement.map((r) => ({
            id: r.requirementId,
            text: r.text,
            evidence: r.chunks
              .map(
                (c, i) =>
                  `[${i + 1}] documentId=${c.documentId} chunk=${c.chunkIndex} file=${c.filename}\n${c.text}`,
              )
              .join("\n---\n"),
          })),
        });

        // #398 — fold the byte-stable standing analysis protocol ahead of the
        // role/schema system message so this single-shot (no-tool) path also
        // clears the Sonnet cache-min floor. All per-request data stays in the
        // user message (behind the data-boundary fences), so nothing volatile
        // precedes the system cachePoint. No tools on this path, so the prefix
        // is `standing protocol + role/schema` only.
        const cachedSystemMessage = buildCachedSystemPrompt(systemMessage, []);

        const response = await this.deps.provider.chat([{ role: "user", content: userMessage }], {
          systemMessage: cachedSystemMessage,
          model: input.model,
          signal: input.signal,
          // #390 — tag prompt-cache hit-ratio telemetry by workload.
          callType: "chat",
          // #398 — enable system-prefix caching on the grounded single-shot path.
          promptCaching: { system: true },
        });

        const { agentOutputSchema } = await import("@metis/shared");
        const parsed = extractJsonObject(response.content);
        if (parsed && typeof parsed === "object") {
          (parsed as Record<string, unknown>).agentKey = agentKey;
        }
        const validated = agentOutputSchema.parse(parsed);

        // Enrich citations and validate the model-supplied requirementId
        // against the known requirement ids (drop hallucinated linkage).
        //
        // NOTE: If the model produces a real finding tagged with a hallucinated
        // requirementId, we null it here. This means the requirement the model
        // *thought* it was addressing is still considered "unaddressed" — so
        // the synthetic gap-finding loop below will emit an info finding for it.
        // This is conservative and acceptable: a redundant info gap is safer
        // than silently persisting a hallucinated linkage. The worst case is a
        // minor extra info finding that the synthesis agent can merge/drop.
        const knownReqIds = new Set(perRequirement.map((r) => r.requirementId));
        // #734 — first ground/normalise CODE citations against the fused symbol
        // provenance (drop hallucinated file:line, normalise `code-graph:` ids),
        // then enrich the surviving DOCUMENT citations with retrieval metadata.
        // #735 — include the deterministically-mapped affected files as
        // provenance so a citation to a mapped file survives grounding even
        // though this path has no tool loop (typically empty: no code graph).
        const codeProvenance = buildCodeProvenance(fused.chunks, affectedCode.filePaths);
        const onDrop = makeCitationDropLogger(input.analysisId, agentKey, "requirement-grounded");
        // #773 — this path runs when the project has NO code graph: it performs no
        // code retrieval at all, so it CANNOT confirm that something is absent from
        // the code. Its absence claims are `could-not-verify` by construction. (The
        // run is separately flagged `no-code-graph`, so this adds no new banner —
        // it only stops "we never looked" from being rendered as "it isn't there".)
        const groundedHealth = noRetrievalHealth(perRequirement.length);
        const absenceConfirmable = absenceIsConfirmable(groundedHealth);
        validated.findings = validated.findings.map((f) => {
          // #740 — verify BEFORE doc enrichment, off the grounded (code) citation
          // set, capturing this finding's drops so an unsupported code claim is
          // marked `unverified` even after enrichCitations re-decorates the list.
          const dropped: DroppedCitation[] = [];
          const grounded = groundCodeCitations(f.citations, codeProvenance, {
            onDrop: (d) => {
              dropped.push(d);
              onDrop(d);
            },
          });
          const claimsAbsence =
            f.verdict === "gap-confirmed" || assertsAbsence({ title: f.title, body: f.body });
          const verdict = gateFindingVerdict({
            modelVerdict: f.verdict ?? null,
            groundedCitations: grounded,
            finding: { title: f.title, body: f.body, tags: f.tags },
            absenceConfirmable,
            // No TOOL loop ran here, so nothing can be confirmed ABSENT. But the
            // #734 provenance the citations are grounded against (fused RAG chunks
            // + #735 affected files) IS real retrieved code — it did not fail — so
            // a cited `implemented` claim stands exactly as it did before #773.
            // The asymmetry is deliberate: absence needs a search, presence needs a
            // citation, and only presence has one here.
            //
            // This is the SAME rule the agentic path now applies via `seedGrounded`
            // (retrieval-health.ts): identical evidence — real, un-failed, retrieved
            // code chunks — is treated identically on both paths, so an agentic pass
            // that was satisfied by the passive seed does not raise a degraded banner
            // that this path would not have raised on the very same chunks.
            retrievalHealthy: true,
            // #826 — the run's reconciled AFFECTED SCHEMA (#823/#824): downgrade a
            // DDL claim the live schema cannot support. Empty ⇒ no-op (flag OFF).
            schemaEvidence: schemaEvidenceFromAffectedRows(affectedSchema.rows),
          });
          const unverifiable = verdict === "could-not-verify";
          return {
            ...f,
            requirementId:
              f.requirementId && knownReqIds.has(f.requirementId) ? f.requirementId : null,
            citations: enrichCitations(grounded, allChunks),
            title: unverifiable ? retitleUnverifiableFinding(f.title) : f.title,
            severity: unverifiable ? ("info" as const) : f.severity,
            verdict,
            verificationStatus: verifyFinding({
              groundedCitations: grounded,
              droppedCitations: dropped,
              assertsAbsence: claimsAbsence,
              absenceConfirmable,
            }),
          };
        });

        // #1109 (Epic #1107) — the multi-lens support panel, AFTER the
        // deterministic verifier and over the MODEL-AUTHORED findings only: the
        // synthetic "could not verify" rows appended below are a statement about
        // the run, not a claim about the code, so there is nothing for a panel to
        // judge and no reason to pay for one. Flag off ⇒ no provider call at all.
        const groundedEvidence = collectPanelEvidence(allChunks);
        const groundedPanel = await applySupportPanel(
          this.deps.provider,
          validated.findings,
          groundedEvidence,
          { ...(input.signal ? { signal: input.signal } : {}) },
        );
        validated.findings = groundedPanel.findings;

        // #1318 (Epic #1316) — the claim-level faithfulness METRIC, over the SAME
        // evidence the panel graded and over the MODEL-AUTHORED findings only.
        // The synthetic rows appended below are a statement about the run, not a
        // claim about the code, so there are no claims of theirs to judge.
        const groundedFaithfulness = await applyFindingFaithfulness(
          this.deps.provider,
          validated.findings,
          groundedEvidence,
          { ...(input.signal ? { signal: input.signal } : {}) },
        );
        validated.findings = groundedFaithfulness.findings;

        // Synthetic severity=info finding for any requirement the model failed
        // to address or that had no evidence — gaps are never dropped (#916).
        // #773 — these are the purest form of the bug this issue targets: the
        // analysis produced NOTHING for the requirement, and the old title said
        // "No grounded evidence for REQ-x", which the gap report then rendered as
        // the gap narrative. They are now explicitly `could-not-verify`.
        const addressed = new Set(
          validated.findings.map((f) => f.requirementId).filter((id): id is string => Boolean(id)),
        );
        for (const r of perRequirement) {
          if (addressed.has(r.requirementId)) continue;
          validated.findings.push({
            requirementId: r.requirementId,
            category: "other",
            severity: "info",
            title: `Could not verify: ${r.requirementId}`,
            body:
              r.chunks.length === 0
                ? `No supporting evidence was retrieved from the selected documents for requirement ${r.requirementId}: "${r.text.slice(0, 200)}". This is NOT a confirmed gap — the analysis could not verify the requirement either way. Review it manually.`
                : `The analysis did not produce a grounded finding for requirement ${r.requirementId}: "${r.text.slice(0, 200)}". This is NOT a confirmed gap — review the retrieved evidence manually.`,
            tags: ["requirement-gap", "could-not-verify"],
            citations: [],
            verdict: "could-not-verify",
            verificationStatus: "could-not-verify",
          });
        }

        const result: AgentRunResult = {
          agentKey,
          output: validated,
          // #1109/#1318 — panel and faithfulness-metric spend are folded into
          // THIS agent's usage so they land in the existing per-agent cost
          // accounting. Both are zero when their flags are off.
          usage: sumTokenUsage(
            sumTokenUsage(
              response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              groundedPanel.usage,
            ),
            groundedFaithfulness.usage,
          ),
          durationMs: Date.now() - startedAt.getTime(),
        };

        await persistAgentResult({
          analysisId: input.analysisId,
          agentKey,
          status: "completed",
          output: result.output,
          startedAt,
          completedAt: new Date(),
          usage: result.usage,
        });

        this.emit({
          analysisId: input.analysisId,
          agentKey,
          type: "completed",
          status: "completed",
          findingCount: result.output.findings.length,
          ts: Date.now(),
        });

        return result;
      } catch (err) {
        const aborted = (err as { name?: string }).name === "AbortError";
        await persistAgentResult({
          analysisId: input.analysisId,
          agentKey,
          status: aborted ? "cancelled" : "failed",
          output: null,
          startedAt,
          completedAt: new Date(),
          errorMessage: aborted ? "cancelled" : (err as Error).message,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        });
        this.emit({
          analysisId: input.analysisId,
          agentKey,
          type: aborted ? "cancelled" : "failed",
          status: aborted ? "cancelled" : "failed",
          errorMessage: (err as Error).message,
          ts: Date.now(),
        });
        throw err;
      }
    });
  }

  /**
   * Extract requirements from the document agent's persisted output (#479).
   *
   * #750 — the document specialist now emits `requirements` as part of its
   * normal structured output (see `buildDocumentExtractionPrompt` +
   * `documentAgentOutputSchema`), so this reads real data instead of always
   * finding `undefined`. An empty array is returned when the project genuinely
   * has no extractable requirements (a docs-free project) OR the document agent
   * failed to complete; either way `detectAgentMode` collapses to single-shot
   * and #733's capability record surfaces the `agentic-unavailable-no-requirements`
   * reason — the degradation is never silent.
   */
  private extractRequirementsFromDocAgent(
    analysisId: string,
  ): Promise<Array<{ id: string; text: string }>> {
    return prisma.agentResult
      .findFirst({
        where: { analysisId, agentKey: "document", status: "completed" },
        select: { output: true },
      })
      .then((row) => {
        if (!row?.output) return [];
        try {
          const parsed = typeof row.output === "string" ? JSON.parse(row.output) : row.output;
          if (Array.isArray(parsed.requirements)) {
            return parsed.requirements
              .map((r: { id?: string; text?: string }, i: number) => ({
                id: r.id ?? `REQ-${String(i + 1).padStart(3, "0")}`,
                text: r.text ?? "",
              }))
              .filter((r: { text: string }) => r.text.length > 0);
          }
        } catch {
          /* ignore parse errors */
        }
        return [];
      });
  }

  private async runSynthesisAndPersist(input: {
    analysisId: string;
    projectId: string;
    projectName: string;
    model?: string;
    signal: AbortSignal;
    accumulator: TokenUsage;
    /**
     * #824 (Epic #820 Phase 1) — the deterministic AFFECTED SCHEMA block so
     * synthesis reconciles code + schema findings per requirement. Undefined ⇒
     * the section is omitted and the synthesis prompt is byte-identical.
     */
    affectedSchema?: string;
  }): Promise<SynthesisOutcome> {
    // Epic #1107 (#1110) — RANK by the #1109 panel's confidence before anything
    // downstream numbers these rows. The reorder happens exactly ONCE, on the
    // source list, and `findings`, `findingIdsByIndex` and `verdictFindings` are
    // all derived from the result — so the `[N]` indexes the synthesis model
    // answers with still resolve to the right Finding row. Sorting any later
    // (inside `runSynthesis`, say) would silently mis-attribute evidence.
    // Flag off ⇒ no row carries a panel ⇒ the sort is the identity function.
    const flat = orderByPanelConfidence(
      await readFlattenedFindings(input.analysisId),
      (f) => f.supportPanel,
    );
    const findings: FlatFinding[] = flat.map((f) => ({
      agentKey: f.agentKey,
      category: f.category,
      severity: f.severity,
      title: f.title,
      body: f.body,
      tags: f.tags,
      citations: f.citations,
      // #740 — carry the verifier verdict into synthesis so `unverified` findings
      // are rendered with an [UNVERIFIED] marker and down-weighted (not dropped).
      verificationStatus: f.verificationStatus,
      // #1110 — and the panel's confidence, so the findings table can mark
      // [LOW-CONFIDENCE] / [UNJUDGED] distinctly. Absent on flag-off runs.
      supportPanel: f.supportPanel,
    }));
    const findingIdsByIndex = flat.map((f) => f.findingId);
    // Epic #201 (#212) — feed clarification-refined requirements (persisted in
    // Analysis.metadata by the clarify route #211) into synthesis so answering
    // clarifying questions measurably changes the generated requirement set.
    const refined = await getStructuredRequirements(input.analysisId);
    const refinedRequirements = (refined?.requirements ?? []).map((r) => ({
      title: r.title,
      description: r.description,
    }));
    const startedAt = new Date();
    this.emit({
      analysisId: input.analysisId,
      agentKey: "synthesis",
      type: "started",
      status: "running",
      ts: Date.now(),
    });
    try {
      const result = await runSynthesis(this.deps.provider, {
        projectName: input.projectName,
        findings,
        signal: input.signal,
        model: input.model,
        refinedRequirements,
        // #824 — reconcile code + schema findings per requirement when present.
        affectedSchema: input.affectedSchema,
      });
      input.accumulator.promptTokens += result.usage.promptTokens;
      input.accumulator.completionTokens += result.usage.completionTokens;
      input.accumulator.totalTokens += result.usage.totalTokens;
      await persistAgentResult({
        analysisId: input.analysisId,
        agentKey: "synthesis",
        status: "completed",
        output: result.output,
        startedAt,
        completedAt: new Date(),
        usage: result.usage,
      });

      // Issue #1117 (findings B + C) — a degraded synthesis changes the output
      // profoundly (no types, no acceptance criteria) and used to leave no
      // trace outside a log line. Record it on the analysis so every later
      // reader — the UI, an operator, a walkthrough — can tell a degraded run
      // from a healthy one without reverse-engineering the agent output blob.
      // Undefined on a healthy run, and also on the pipeline suites that mock
      // `runSynthesis` — both correctly mean "nothing to report".
      //
      // Deliberately metadata-only, with no socket event: the analysis page
      // already polls `metadata` (that is how #1104's gated-requirements notice
      // reaches the screen), and the alternative was inventing an
      // `AnalysisAgentEventType` for a state the user reads after the run ends.
      if (result.degraded) {
        await persistAnalysisEnhancement(input.analysisId, {
          synthesisDegraded: result.degraded,
        });
      }

      // Epic #202 (#216) — gate artifact promotion on resolved approvals.
      // Synthesis still runs (so the agent result is captured), but promotion
      // of the generated requirements into durable `Requirement` rows is
      // blocked until every approval request is `approved` (no pending, none
      // rejected). This is the same check the ticket-creation path uses, now
      // extended to doc/spec promotion. The blocked state is persisted to
      // analysis metadata and surfaced on the socket so the UI (#217) can show
      // a clear "promotion blocked" notice — never a silent promotion.
      const ticketStatus = await canCreateTickets(input.analysisId);
      if (!ticketStatus.allowed) {
        // Issue #1104 (finding B) — the run produced requirements; the gate is
        // WITHHOLDING them. Record how many so every surface (metadata, socket,
        // job event, UI) can say "N requirements awaiting approval" instead of
        // presenting an empty, apparently-successful run.
        const awaitingRequirementCount = result.output.requirements.length;
        const { reason: blockedReason } = describePromotionGate({
          pendingCount: ticketStatus.pendingCount,
          rejectedCount: ticketStatus.rejectedCount,
          awaitingRequirementCount,
        });
        await persistAnalysisEnhancement(input.analysisId, {
          promotionBlocked: {
            blocked: true,
            pendingCount: ticketStatus.pendingCount,
            rejectedCount: ticketStatus.rejectedCount,
            awaitingRequirementCount,
            reason: blockedReason,
          },
          // #258 — record the coarse outcome in the SAME metadata patch as the
          // marker (one DB write, not two).
          promotionStatus: "blocked",
        });
        this.emit({
          analysisId: input.analysisId,
          agentKey: "synthesis",
          type: "completed",
          status: "completed",
          findingCount: 0,
          message: blockedReason,
          ts: Date.now(),
        });
        // #256 — emit a DISTINCT promotion-blocked event so the UI can show a
        // precise indicator from the socket stream alone, rather than inferring
        // the blocked state from the generic agent-completed message above.
        this.emitPromotionBlocked(input.analysisId, {
          pendingCount: ticketStatus.pendingCount,
          rejectedCount: ticketStatus.rejectedCount,
          reason: blockedReason,
        });
        return {
          promotionBlocked: {
            pendingCount: ticketStatus.pendingCount,
            rejectedCount: ticketStatus.rejectedCount,
            awaitingRequirementCount,
            reason: blockedReason,
          },
        };
      }

      // Epic #203 (#221) — cross-document conflict / contradiction /
      // completeness detection over the ingested-doc-derived findings. Runs
      // post-synthesis, BEFORE persistRequirements, and surfaces findings as
      // first-class analysis output. Best-effort: a detection failure (or an
      // offline provider that can't emit parseable JSON) never fails the
      // analysis — it just yields an empty cross-doc finding set.
      await this.runCrossDocDetectionAndPersist({
        analysisId: input.analysisId,
        flatFindings: flat,
        model: input.model,
        signal: input.signal,
        accumulator: input.accumulator,
      });

      // Epic #726 (#736) — deterministic per-requirement coverage classification
      // from the linked-finding citation shapes (code vs docs vs none). Pure +
      // LLM-free; `findings` carries the merged citations the synthesis model saw
      // via `evidenceFindingIndexes`, so this is a direct lookup, not a re-read.
      const coverages = computeCoverageForRequirements(result.output.requirements, findings);

      // Issue #773 — the per-requirement VERDICT, rolled up from the linked CODE
      // findings' already-gated verdicts. This is the field that answers "must we
      // build this?"; coverage only says what KIND of evidence exists (a
      // `grounded_in_code` requirement is NOT necessarily implemented, and a
      // `no_evidence` one is NOT necessarily a gap — that conflation is #773).
      // A requirement with no linked code finding — because the agent never
      // reached it (turn/token budget) — rolls up to `could-not-verify`, never a gap.
      const codeAnalysisRan =
        this.capabilities.get(input.analysisId)?.codeAnalysisRequested ??
        flat.some((f) => f.agentKey === "code");
      const verdictFindings: VerdictFindingInput[] = flat.map((f) => ({
        agentKey: f.agentKey,
        verdict: f.verdict ?? null,
      }));
      const verdicts = computeVerdictsForRequirements(
        result.output.requirements,
        verdictFindings,
        codeAnalysisRan,
      );

      const requirementIds = await persistRequirements({
        analysisId: input.analysisId,
        projectId: input.projectId,
        synthesis: result.output,
        findingIdsByIndex,
        coverages,
        verdicts,
      });

      // feat/req-code-traceability — auto-seed the requirement→code spine from
      // the CODE agent's finding citations so each requirement's "Requirement →
      // Spec → Code" panel shows the code it impacts with no manual click. Pure
      // enrichment: best-effort, so a failure never fails the analysis.
      try {
        await seedRequirementCodeLinksFromFindings({
          analysisId: input.analysisId,
          projectId: input.projectId,
          requirementIds,
        });
      } catch (seedErr) {
        log.warn("requirement→code link seeding failed (non-fatal)", {
          analysisId: input.analysisId,
          error: String(seedErr),
        });
      }
      // #258 — clear the durable blocked marker AND record the coarse
      // `allowed` outcome in a SINGLE metadata patch (one DB write instead of
      // two) now that promotion succeeded.
      await persistAnalysisEnhancement(input.analysisId, {
        promotionBlocked: { blocked: false, pendingCount: 0, rejectedCount: 0 },
        promotionStatus: "allowed",
      });
      this.emit({
        analysisId: input.analysisId,
        agentKey: "synthesis",
        type: "completed",
        status: "completed",
        findingCount: result.output.requirements.length,
        ts: Date.now(),
      });
      return {};
    } catch (err) {
      await persistAgentResult({
        analysisId: input.analysisId,
        agentKey: "synthesis",
        status: "failed",
        output: null,
        startedAt,
        completedAt: new Date(),
        errorMessage: (err as Error).message,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });
      this.emit({
        analysisId: input.analysisId,
        agentKey: "synthesis",
        type: "failed",
        status: "failed",
        errorMessage: (err as Error).message,
        ts: Date.now(),
      });
      throw err;
    }
  }

  /**
   * Epic #203 (#221) — run cross-document conflict / contradiction /
   * completeness detection over the ingested-doc-derived findings and persist
   * the results as first-class analysis output. Best-effort: never throws — a
   * detection failure is logged and yields no cross-doc findings rather than
   * failing the analysis. Token usage is rolled into the supplied accumulator.
   *
   * Segments are built from the persisted specialist findings (which are
   * grounded in the ingested customer documents), tagged by their originating
   * finding id so contradictions/gaps can reference evidence. This keeps the
   * pass deterministic and offline-safe (no extra retrieval round-trips).
   */
  private async runCrossDocDetectionAndPersist(input: {
    analysisId: string;
    flatFindings: Array<{
      findingId: string;
      agentKey: AnalysisAgentKey;
      title: string;
      body: string;
    }>;
    model?: string;
    signal: AbortSignal;
    accumulator: TokenUsage;
  }): Promise<void> {
    try {
      const segments: DocSegment[] = input.flatFindings
        .map((f) => ({
          id: f.findingId,
          label: `${f.agentKey}:${f.title}`.slice(0, 120),
          content: [f.title, f.body].filter(Boolean).join("\n"),
        }))
        .filter((s) => s.content.trim().length > 0);

      if (segments.length === 0) return;

      // Epic #208 (E6.4) — elicit NFRs/ACs/assumptions/risks over the corpus
      // and feed them into the completeness checklist as additional context so
      // the checker accounts for facts captured outside the raw documents.
      // Best-effort: a failure degrades to "no elicited artifacts".
      let elicitedArtifacts: string | undefined;
      try {
        const elicitation = await runElicitation({
          provider: this.deps.provider,
          segments,
          model: input.model,
          signal: input.signal,
        });
        input.accumulator.promptTokens += elicitation.usage.promptTokens;
        input.accumulator.completionTokens += elicitation.usage.completionTokens;
        input.accumulator.totalTokens += elicitation.usage.totalTokens;
        if (!isEmptyElicitation(elicitation)) {
          elicitedArtifacts = formatElicitedArtifacts(elicitation);
        }
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") throw err;
        log.warn("Elicitation failed (non-fatal); completeness runs without artifacts", {
          analysisId: input.analysisId,
          error: (err as Error).message,
        });
      }

      const detection = await runCrossDocDetection({
        provider: this.deps.provider,
        segments,
        model: input.model,
        signal: input.signal,
        elicitedArtifacts,
      });

      input.accumulator.promptTokens += detection.usage.promptTokens;
      input.accumulator.completionTokens += detection.usage.completionTokens;
      input.accumulator.totalTokens += detection.usage.totalTokens;

      await persistCrossDocFindings({
        analysisId: input.analysisId,
        findings: detection.findings,
      });

      log.info("Cross-doc detection persisted", {
        analysisId: input.analysisId,
        contradictions: detection.contradictionCount,
        completenessGaps: detection.completenessGapCount,
      });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") throw err;
      log.error("Cross-doc detection failed (non-fatal)", {
        analysisId: input.analysisId,
        error: (err as Error).message,
      });
    }
  }

  private async retrieveContext(input: {
    /** #733 — id used to flag quarantine-fallback usage on the capability tracker. */
    analysisId?: string;
    projectId: string;
    agentKey: AnalysisSpecialistAgentKey;
    documentIds?: string[];
    projectName?: string;
    projectDescription?: string;
    extraInstructions?: string;
    /** #732 — actor for the database agent's schema introspection (see below). */
    actorId?: string;
  }): Promise<RetrievalContextChunk[]> {
    if (this.deps.retrieve)
      return this.deps.retrieve({
        projectId: input.projectId,
        agentKey: input.agentKey,
        documentIds: input.documentIds,
      });
    const knowledge = this.deps.knowledge ?? getKnowledgeService();

    // Code agent needs BOTH business requirements AND source code to do a gap
    // analysis. Retrieve the requirements half (grounded in the user's selected
    // documents, #913/#914) then the source-code half via keyword search, and
    // merge.
    if (input.agentKey === "code") {
      // Honour the user's document selection (#913). When nothing is selected,
      // fall back to ALL ready, user-uploaded (non-connector) documents.
      let requirementDocIds = input.documentIds ?? [];
      if (requirementDocIds.length === 0) {
        const uploadedDocs = await prisma.document.findMany({
          where: {
            projectId: input.projectId,
            deletedAt: null,
            status: "ready",
            filename: { not: { startsWith: "connector:" } },
          },
          select: { id: true },
        });
        requirementDocIds = uploadedDocs.map((d) => d.id);
      }

      // Requirements half — query derived from project metadata + operator
      // notes (#914/#915), fused with the static "requirements" bag (#917).
      const requirementChunks =
        requirementDocIds.length > 0
          ? await runGroundedRetrieval(knowledge, {
              projectId: input.projectId,
              queries: buildRetrievalQueries({
                agentKey: input.agentKey,
                projectName: input.projectName,
                projectDescription: input.projectDescription,
                extraInstructions: input.extraInstructions,
                staticBag: CODE_REQUIREMENTS_QUERY,
              }),
              documentIds: requirementDocIds,
              k: ANALYSIS_RETRIEVE_K,
            })
          : [];

      // Quarantine fallback for the requirements half: when the selected
      // requirement documents have no approved knowledge chunks (e.g. newly
      // uploaded / pending approval), the code agent would otherwise see only
      // source code and report "no requirements retrieved". Pull the raw
      // quarantine chunks so gap analysis can still run.
      let effectiveRequirementChunks = requirementChunks;
      if (requirementChunks.length === 0 && requirementDocIds.length > 0) {
        const fallback = await this.fetchQuarantineFallback(input.projectId, requirementDocIds);
        if (fallback.length > 0) {
          // #733 — the code agent grounded on raw quarantine chunks; flag it so
          // the UI can note the grounding was weaker than approved knowledge.
          this.markQuarantineFallback(input.analysisId);
          effectiveRequirementChunks = fallback;
        }
      }

      // Source-code half — queries derived from project metadata + operator
      // notes (#731), fused with the static "code" keyword bag as a fallback.
      // Source chunks aren't part of the user's document selection, so they're
      // never documentId-filtered. On this single-shot path no requirements were
      // extracted (that's why `detectAgentMode` routed here), so the derivation
      // reduces to metadata + `extraInstructions`; when both are empty it
      // collapses to the static bag exactly (behaviour-preserving fallback).
      const codeChunks = await runGroundedRetrieval(knowledge, {
        projectId: input.projectId,
        queries: buildRetrievalQueries({
          agentKey: input.agentKey,
          projectName: input.projectName,
          projectDescription: input.projectDescription,
          extraInstructions: input.extraInstructions,
          staticBag: RETRIEVAL_QUERIES.code,
        }),
        k: ANALYSIS_RETRIEVE_K,
      });

      // Merge, requirements first, de-duplicated by chunk identity.
      const seen = new Set<string>();
      const combined: RetrievalContextChunk[] = [];
      for (const c of [...effectiveRequirementChunks, ...codeChunks]) {
        const key = `${c.documentId}:${c.chunkIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        combined.push(c);
      }

      // #729 (Epic #725) — fuse code-graph SYMBOL hits into the code agent's
      // context, env-gated ON by default (`ANALYSIS_FUSED_CODE_RETRIEVAL`, #752).
      // Hits are deduped against the source-as-RAG chunks retrieved above and
      // token-budgeted; each surviving chunk carries filePath:startLine-endLine
      // provenance for Epic #726 citations. Flag off ⇒ `[]` without touching
      // the searcher, so `combined` is returned unchanged.
      //
      // NOTE ON REACHABILITY: `retrieveContext` is only invoked from
      // `runOneAgent`, i.e. the code agent's SINGLE-SHOT path — which
      // `detectAgentMode` selects ONLY when NO requirements were extracted. The
      // two modes where a code graph actually exists reach the fused block via
      // their own seams instead: `runAgenticCodeAgent` (graph present) seeds it
      // into the agentic prompt before the tool loop, and
      // `runRequirementGroundedCodeAgent` (requirements, no graph) folds it into
      // the grounded evidence. Both share `retrieveFusedCodeContext`.
      const fusedChunks = await retrieveFusedCodeChunks({
        projectId: input.projectId,
        query: deriveRetrievalQuery({
          projectName: input.projectName,
          projectDescription: input.projectDescription,
          extraInstructions: input.extraInstructions,
          fallback: RETRIEVAL_QUERIES.code,
        }),
        ragChunks: combined.map((c) => ({ filename: c.filename })),
        deps: this.deps.fusedCode,
      });
      return fusedChunks.length > 0 ? [...combined, ...fusedChunks] : combined;
    }

    // Specialist agents (document/database/web) — multi-query grounded
    // retrieval derived from project metadata + operator notes (#914/#915/#917),
    // honouring the user's document selection (#913).
    const chunks = await runGroundedRetrieval(knowledge, {
      projectId: input.projectId,
      queries: buildRetrievalQueries({
        agentKey: input.agentKey,
        projectName: input.projectName,
        projectDescription: input.projectDescription,
        extraInstructions: input.extraInstructions,
      }),
      documentIds: input.documentIds,
      k: ANALYSIS_RETRIEVE_K,
    });

    // If no approved chunks were found for explicitly-selected documents, fall
    // back to quarantine chunks. This lets the LLM analyze newly-uploaded or
    // pending-approval documents rather than reporting "no context available".
    let baseChunks = chunks;
    if (chunks.length === 0 && input.documentIds && input.documentIds.length > 0) {
      const fallback = await this.fetchQuarantineFallback(input.projectId, input.documentIds);
      if (fallback.length > 0) baseChunks = fallback;
    }

    // #732 (Epic #725) — Sally (the DATABASE agent) needs the live data model, not
    // just documents, to ground entity/attribute/relationship findings. Introspect
    // the project's primary DB connector (read-only) and append a token-budgeted
    // schema summary AFTER the doc chunks, env-gated ON by default
    // (`ANALYSIS_SCHEMA_CONTEXT`, #752). Flag off, no connector, or an introspection
    // failure ⇒ `[]` without touching the introspector, so `baseChunks` is
    // returned unchanged and the docs-only behaviour is byte-identical to today.
    //
    // REACHABILITY: `retrieveContext` is invoked from `runOneAgent`, which the
    // database agent always enters single-shot (specialists have no agentic mode
    // — only `code` does via `detectAgentMode`). So this branch is genuinely on
    // Sally's path: start → runPipeline → runOneAgent("database") → retrieveContext.
    if (input.agentKey === "database") {
      // #1312 — rank the schema summary against what this analysis is actually
      // about. Usage tags alone left the requirement's own tables (untagged and
      // alphabetically late) demoted to #1310's name-only overflow index, so the
      // agent could see their names but never their columns. The extra
      // instructions plus the already-retrieved doc chunks are the best available
      // statement of intent and cost nothing extra to reuse here.
      const relevanceText = [input.extraInstructions ?? "", ...baseChunks.map((c) => c.text)].join(
        "\n",
      );
      const schemaChunks = await retrieveSchemaContextChunks({
        projectId: input.projectId,
        actorId: input.actorId ?? "",
        relevanceText,
        deps: this.deps.schemaContext,
      });
      if (schemaChunks.length > 0) return [...baseChunks, ...schemaChunks];
    }

    return baseChunks;
  }

  /**
   * Fetch raw quarantine chunks for the given documents as retrieval context.
   * Used as a fallback when grounded retrieval over approved knowledge chunks
   * returns nothing for explicitly-selected documents (e.g. newly uploaded or
   * pending-approval docs that only exist in quarantine). Shared by the
   * specialist agents and the code agent's requirements half.
   */
  private async fetchQuarantineFallback(
    projectId: string,
    documentIds: string[],
  ): Promise<RetrievalContextChunk[]> {
    const quarantineRows = await prisma.quarantineChunk.findMany({
      where: { documentId: { in: documentIds }, projectId, ord: { gte: 0 } },
      select: {
        documentId: true,
        ord: true,
        text: true,
        document: { select: { filename: true } },
      },
      orderBy: [{ documentId: "asc" }, { ord: "asc" }],
      take: ANALYSIS_RETRIEVE_K,
    });
    return quarantineRows.map(
      (row): RetrievalContextChunk => ({
        documentId: row.documentId,
        chunkIndex: row.ord,
        filename: row.document?.filename ?? "",
        text: row.text,
        score: 0,
      }),
    );
  }

  /**
   * #733 — mark the run's capability tracker to note the code agent fell back to
   * raw quarantine chunks. No-op when the analysisId is unknown (e.g. the
   * single-agent regenerate path, which carries no tracker).
   */
  private markQuarantineFallback(analysisId?: string): void {
    if (!analysisId) return;
    const tracker = this.capabilities.get(analysisId);
    if (tracker) tracker.quarantineFallbackUsed = true;
  }

  /**
   * #769 — mark the run's capability tracker to note that an agentic code pass
   * could not serialize a JSON answer and degraded to partial/empty findings.
   * No-op when the analysisId carries no tracker (single-agent regenerate).
   */
  private markCodeAgentDegraded(analysisId?: string): void {
    if (!analysisId) return;
    const tracker = this.capabilities.get(analysisId);
    if (tracker) tracker.codeAgentDegraded = true;
  }

  /**
   * #777 — mark the run's capability tracker to note that a repo connector exists but
   * its clone is NOT on disk, so the agentic code pass ran WITHOUT file tools (code
   * graph + symbol search only). Surfaced as its OWN banner reason
   * (`repo-clone-unavailable`), never as `code-retrieval-degraded`: the run's verdicts
   * are sound — the investigation was simply shallower. No-op when the analysisId
   * carries no tracker (single-agent regenerate).
   */
  private markRepoCloneUnavailable(analysisId?: string): void {
    if (!analysisId) return;
    const tracker = this.capabilities.get(analysisId);
    if (tracker) tracker.repoCloneUnavailable = true;
  }

  /**
   * #773 — record one agentic code pass's retrieval health on the run, and flag
   * the capability tracker when it fell below the evidence threshold. This is what
   * makes tool health an INPUT TO THE VERDICT rather than a banner afterthought:
   * the same signal gates the findings (`gateFindingVerdict`) and the run's
   * `code-retrieval-degraded` reason.
   *
   * The banner fires whenever the RUN was degraded — NOT only when a claim
   * happened to be downgraded. Gating it on a downgrade left the worst case
   * silent: on a run where every search failed, a model claiming a requirement is
   * `implemented` (grounded by the #729 passive seed, which needs no search) got
   * no downgrade, therefore no banner — a real gap closed with nothing anywhere
   * telling the user to look again. Degradation is a property of the RUN, so it
   * is reported as one. It still does not fire on a healthy run: a banner on every
   * run trains users to ignore the one that matters.
   */
  private recordRetrievalHealth(analysisId: string, health: AnalysisRetrievalHealth): void {
    const existing = this.retrievalHealths.get(analysisId) ?? [];
    existing.push(health);
    this.retrievalHealths.set(analysisId, existing);
    if (health.degraded) {
      const tracker = this.capabilities.get(analysisId);
      if (tracker) tracker.codeRetrievalDegraded = true;
    }
  }

  /**
   * #733 — finalize the capability tracker into an immutable record, persist it
   * to the analysis metadata, and emit the final state on the socket. Best-effort:
   * never throws into the completion path.
   */
  /**
   * #735 (Epic #726) — compute the deterministic requirement→code mapping for
   * the run's free-text new requirements and persist it onto the analysis
   * metadata for the UI/API. Best-effort: any failure degrades to the empty
   * (no-op) context so the analysis run proceeds with today's behaviour.
   */
  private async computeAffectedCode(
    analysisId: string,
    projectId: string,
    extraInstructions?: string,
  ): Promise<AffectedCodeContext> {
    let ctx: AffectedCodeContext = EMPTY_AFFECTED_CODE_CONTEXT;
    try {
      ctx = await computeAffectedCodeContext({
        projectId,
        extraInstructions,
        deps: this.deps.affectedCode,
      });
    } catch (err) {
      log.warn("Affected-code mapping failed; degrading to no-op", {
        analysisId,
        error: (err as Error).message,
      });
      return EMPTY_AFFECTED_CODE_CONTEXT;
    }
    // Persist only when there is something to show (keeps pre-#735 + plain runs
    // free of an empty `affectedCode` blob). Best-effort — never blocks the run.
    if (ctx.result.candidates.length > 0) {
      try {
        await persistAnalysisAffectedCode(analysisId, ctx.result);
      } catch (err) {
        log.warn("Affected-code persist failed", { analysisId, error: (err as Error).message });
      }
    }
    return ctx;
  }

  /**
   * #824 (Epic #820 Phase 1) — compute the deterministic AFFECTED SCHEMA block
   * for the run's free-text new requirements, reusing the impact machinery +
   * #823's schema crossing (`computeRunAffectedSchemaContext`). Best-effort: any
   * failure degrades to {@link EMPTY_AFFECTED_SCHEMA_CONTEXT} so the analysis run
   * proceeds with today's behaviour.
   *
   * #855 (Epic #852 Phase 2b) — `enabled` is the caller-resolved decision
   * (`resolveDatabaseAware`, driven by #854's resolver). When omitted,
   * `computeRunAffectedSchemaContext` falls back to the bare
   * `ANALYSIS_AFFECTED_SCHEMA_MAPPING` env flag for backward compatibility with
   * callers that predate #855 (e.g. a direct `runPipeline` invocation in a test
   * harness with no project setting threaded through).
   */
  private async computeAffectedSchema(
    analysisId: string,
    projectId: string,
    extraInstructions?: string,
    enabled?: boolean,
  ): Promise<AffectedSchemaContext> {
    try {
      return await computeRunAffectedSchemaContext({
        projectId,
        extraInstructions,
        enabled,
        deps: this.deps.affectedSchemaMapping,
      });
    } catch (err) {
      log.warn("Affected-schema mapping failed; degrading to no-op", {
        analysisId,
        error: (err as Error).message,
      });
      return EMPTY_AFFECTED_SCHEMA_CONTEXT;
    }
  }

  /**
   * #855 (Epic #852 Phase 2b) — resolve the per-project database-aware-analysis
   * decision for this run: validate the project's `databaseAwareAnalysis`
   * setting (untrusted; an unrecognized value degrades to the documented
   * default via #854's resolver — see `database-aware-resolver.ts` OWASP note),
   * probe schema-data presence (`hasSchemaData`, #854), fold both plus the two
   * legacy env flags into ONE decision via `resolveDatabaseAwareAnalysis`
   * (#854), and persist `{ setting, enabled, ran, reason }` on analysis
   * metadata (`metadata.databaseAware`) so a resolved-OFF or
   * resolved-ON-but-no-schema-data run is an observable skip — never a silent
   * no-op. Best-effort throughout: a schema-data probe failure degrades to
   * "no schema data" (fail closed — schema reasoning is skipped, never silently
   * assumed present) and a persist failure never blocks the run.
   */
  private async resolveDatabaseAware(
    analysisId: string,
    projectId: string,
    settingRaw: string | undefined,
  ): Promise<AnalysisDatabaseAware> {
    const settings: readonly string[] = DATABASE_AWARE_ANALYSIS_SETTINGS;
    const setting: DatabaseAwareAnalysisSetting = settings.includes(settingRaw ?? "")
      ? (settingRaw as DatabaseAwareAnalysisSetting)
      : DEFAULT_DATABASE_AWARE_ANALYSIS_SETTING;

    // #849 — read via the shared helper so the run path and the gap-report
    // path apply the identical default (ON) and the identical
    // explicitly-configured probe (`describeSource`).
    const envDefault: DbAwareEnvDefault = readDbAwareEnvDefault(getConfigService());

    let dataPresent = false;
    try {
      dataPresent = await probeHasSchemaData(
        prisma as unknown as SchemaDataPrismaClient,
        projectId,
      );
    } catch (err) {
      log.warn("Database-aware schema-data probe failed; degrading to no schema data", {
        analysisId,
        projectId,
        error: (err as Error).message,
      });
    }

    const resolved = resolveDatabaseAwareAnalysis({
      setting,
      envDefault,
      hasSchemaData: dataPresent,
    });
    const record: AnalysisDatabaseAware = { setting, ...resolved };

    try {
      await persistAnalysisDatabaseAware(analysisId, record);
    } catch (err) {
      log.warn("Database-aware decision persist failed", {
        analysisId,
        error: (err as Error).message,
      });
    }
    return record;
  }

  /**
   * #739 (Epic #727) — score the extracted requirements for ambiguity + impact,
   * decide which get a deep multi-hop pass, persist the decision for the UI, and
   * return the routing + turn caps for the agentic pass to consume. Returns
   * `undefined` (a clean no-op) when the policy is disabled or there is nothing
   * to score. Never throws — a failure degrades to today's uniform-depth run.
   */
  private async computeEscalations(
    analysisId: string,
    projectId: string,
    requirements: Array<{ id: string; text: string }>,
  ): Promise<RunEscalation | undefined> {
    let ctx;
    try {
      ctx = await computeRequirementEscalations({
        projectId,
        requirements,
        deps: this.deps.affectedCode,
      });
    } catch (err) {
      log.warn("Escalation scoring failed; degrading to uniform depth", {
        analysisId,
        error: (err as Error).message,
      });
      return undefined;
    }
    if (!ctx) return undefined;
    // Best-effort persist — never blocks the run.
    try {
      await persistAnalysisEscalation(analysisId, ctx.escalation);
    } catch (err) {
      log.warn("Escalation persist failed", { analysisId, error: (err as Error).message });
    }
    return { decisions: ctx.escalation.requirements, policy: ctx.policy };
  }

  private async finalizeAndPersistCapability(analysisId: string): Promise<void> {
    const tracker = this.capabilities.get(analysisId);
    if (!tracker) return;
    // #770 — fold the code agent's OBSERVABLE persisted outcome into the record
    // before freezing it. Every agent row is persisted by now, so one read covers
    // all three code-agent modes: a run whose code agent died never again reports
    // a clean `reasons: []`. Best-effort — a read failure must not block completion.
    if (tracker.codeAnalysisRequested) {
      try {
        tracker.codeAgentFailed = await detectCodeAgentFailed(analysisId);
      } catch (err) {
        log.warn("Code-agent outcome read failed", { analysisId, error: (err as Error).message });
      }
    }
    const capability = finalizeCapability(tracker);
    try {
      await persistAnalysisCapability(analysisId, capability);
    } catch (err) {
      log.warn("Capability persist failed", { analysisId, error: (err as Error).message });
    }
    // #773 — persist the run's retrieval health + searched-scope provenance so the
    // gap report can show WHICH queries backed (or failed to back) each verdict.
    // Best-effort: never blocks completion.
    const health = mergeRetrievalHealth(this.retrievalHealths.get(analysisId) ?? []);
    if (health) {
      try {
        await persistAnalysisEnhancement(analysisId, { retrieval: health });
      } catch (err) {
        log.warn("Retrieval-health persist failed", {
          analysisId,
          error: (err as Error).message,
        });
      }
    }
    this.retrievalHealths.delete(analysisId);
    // Emit from the tracker (which `emitCapability` finalizes) — byte-identical
    // to `capability` above, and keeps the CapabilityTracker contract honest now
    // that the record's #769/#770 flags are optional for legacy compatibility.
    this.emitCapability(analysisId, tracker);
  }

  /** #733 — broadcast the current capability record on the `analysis:{id}` room. */
  private emitCapability(analysisId: string, tracker: CapabilityTracker): void {
    if (!this.deps.io) return;
    const event: AnalysisCapabilityEvent = {
      analysisId,
      capability: finalizeCapability(tracker),
      ts: Date.now(),
    };
    try {
      this.deps.io.to(`analysis:${analysisId}`).emit("analysis:capability", event);
    } catch (err) {
      log.warn("Socket emit failed", { error: (err as Error).message });
    }
  }

  /**
   * #741 — broadcast the structured multi-repo budget-cap warning on the
   * `analysis:{id}` room the moment repos are dropped, so the UI surfaces the
   * "re-run remaining repos" action mid-run.
   */
  private emitReposSkipped(analysisId: string, skipped: AnalysisSkippedRepo[]): void {
    if (!this.deps.io || skipped.length === 0) return;
    const event: AnalysisReposSkippedEvent = {
      analysisId,
      skipped: [...skipped],
      reason: "repos-skipped-budget",
      minPerRepoTokenBudget: MIN_PER_REPO_TOKEN_BUDGET,
      ts: Date.now(),
    };
    try {
      this.deps.io.to(`analysis:${analysisId}`).emit("analysis:repos-skipped", event);
    } catch (err) {
      log.warn("Socket emit failed", { error: (err as Error).message });
    }
  }

  private emit(event: AnalysisAgentEvent): void {
    if (!this.deps.io) return;
    try {
      this.deps.io.to(`analysis:${event.analysisId}`).emit("analysis:agent", event);
    } catch (err) {
      log.warn("Socket emit failed", { error: (err as Error).message });
    }
  }

  private emitCompleted(analysisId: string): void {
    if (!this.deps.io) return;
    try {
      this.deps.io.to(`analysis:${analysisId}`).emit("analysis:completed", { analysisId });
    } catch (err) {
      log.warn("Socket emit failed", { error: (err as Error).message });
    }
  }

  /**
   * #256 — emit a distinct promotion-blocked outcome on the `analysis:{id}`
   * room. Best-effort and fire-and-forget like the other emit helpers.
   */
  private emitPromotionBlocked(
    analysisId: string,
    detail: { pendingCount: number; rejectedCount: number; reason: string },
  ): void {
    if (!this.deps.io) return;
    try {
      this.deps.io.to(`analysis:${analysisId}`).emit("analysis:promotion-blocked", {
        analysisId,
        pendingCount: detail.pendingCount,
        rejectedCount: detail.rejectedCount,
        reason: detail.reason,
        ts: Date.now(),
      });
    } catch (err) {
      log.warn("Socket emit failed", { error: (err as Error).message });
    }
  }

  /**
   * Emit the `analysis:failed` event on the `analysis:{id}` room. The
   * `errorMessage` MUST be a generic, user-safe string (see #254): the room is
   * joined by any authenticated socket via `subscribe:analysis`, so raw error
   * detail must never be passed here. The raw error stays in server logs and the
   * persisted analysis row only.
   */
  private emitFailed(analysisId: string, errorMessage: string): void {
    if (!this.deps.io) return;
    try {
      this.deps.io
        .to(`analysis:${analysisId}`)
        .emit("analysis:failed", { analysisId, errorMessage });
    } catch (err) {
      log.warn("Socket emit failed", { error: (err as Error).message });
    }
  }

  private emitCancelled(analysisId: string): void {
    if (!this.deps.io) return;
    try {
      this.deps.io.to(`analysis:${analysisId}`).emit("analysis:cancelled", { analysisId });
    } catch (err) {
      log.warn("Socket emit failed", { error: (err as Error).message });
    }
  }

  /**
   * Epic #593 / #601 — Select the optimal model for a specialist agent by
   * profiling the retrieved context and consulting project preferences.
   */
  private async selectModelForAgent(
    projectId: string,
    agentKey: AnalysisSpecialistAgentKey,
    retrieved: RetrievalContextChunk[],
  ): Promise<string | undefined> {
    try {
      const content = retrieved.map((c) => c.text).join("\n");
      const profiler = new TaskProfiler();
      const profile = profiler.classify(content, agentKey);

      const pref = await prisma.modelPreference.findUnique({
        where: { projectId },
      });

      // #1095 — was `TokenUsage`, which the analysis pipeline never writes, so
      // this read 0 for every project and `budgetDowngradeThreshold` could never
      // trip. Use the same `Analysis`-derived accounting as the cost cap.
      const currentMonthTokens = await getProjectMonthlyAnalysisTokens(projectId);

      const preferences: ModelPreferences | undefined = pref
        ? {
            defaultModel: pref.defaultModel ?? undefined,
            taskTypeOverrides: safeParse<Record<string, string>>(pref.taskTypeOverrides),
            budgetDowngradeThreshold: pref.budgetDowngradeThreshold,
          }
        : undefined;

      const router = new ModelRouter({ preferences, currentMonthTokens });

      const selection = router.select(profile);
      log.info("Model selected for agent", {
        agentKey,
        modelId: selection.modelId,
        rationale: selection.rationale,
        wasDowngraded: selection.wasDowngraded,
      });
      return selection.modelId;
    } catch (err) {
      log.warn("Model selection failed, falling back to default", {
        agentKey,
        error: (err as Error).message,
      });
      return undefined;
    }
  }
}

function safeParse<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

let singleton: AnalysisOrchestrator | null = null;

export function getOrchestrator(deps?: OrchestratorDeps): AnalysisOrchestrator {
  if (!singleton) {
    if (!deps) throw new Error("Orchestrator must be initialised with deps before first use");
    singleton = new AnalysisOrchestrator(deps);
  }
  return singleton;
}

export function setOrchestratorForTests(orch: AnalysisOrchestrator | null): void {
  singleton = orch;
}
