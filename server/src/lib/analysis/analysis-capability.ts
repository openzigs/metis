/**
 * Analysis capability detection (Issue #733, Epic #725).
 *
 * The analysis pipeline degrades silently in several ways: no code graph → the
 * code agent can't run agentic; no ingested repo source → the source-code half
 * of retrieval returns nothing; `ANALYSIS_FUSED_CODE_RETRIEVAL` (#729) and
 * `ANALYSIS_SCHEMA_CONTEXT` (#732) are ON by default (#752) but an operator may
 * disable either; multi-repo runs skip
 * repos when the per-repo token budget is too low; the code agent falls back to
 * raw quarantine chunks. This module detects those signals so the orchestrator
 * can persist a structured {@link AnalysisCapability} record and the UI can
 * explain — rather than swallow — the degraded run.
 *
 * Detection here is READ-ONLY and cheap (two indexed `findFirst`s + two config
 * reads). The reason derivation is a PURE shared function
 * ({@link deriveCapabilityReasons}) so the server and UI never drift.
 */
import {
  type AnalysisAgentMode,
  type AnalysisCapability,
  type AnalysisCapabilityPreview,
  type AnalysisSkippedRepo,
  type RequirementInputAccount,
  deriveCapabilityReasons,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { getConfigService } from "../config/config-service.js";

/** Document filename prefix for repo source ingested as knowledge (see connector-ingest.ts). */
const REPO_SOURCE_PREFIX = "connector:repo:";

/**
 * Project-level facts knowable before (and independent of) a run: whether a
 * code graph exists, whether repo source was ingested as knowledge, and the two
 * grounding feature flags. Two indexed lookups + two config reads.
 */
export async function detectStaticCapability(
  projectId: string,
): Promise<AnalysisCapabilityPreview> {
  const cfg = getConfigService();
  const [codeGraph, repoSourceDoc] = await Promise.all([
    prisma.codeGraph.findFirst({
      where: { projectId },
      select: { id: true },
      orderBy: { lastIndexedAt: "desc" },
    }),
    prisma.document.findFirst({
      where: { projectId, deletedAt: null, filename: { startsWith: REPO_SOURCE_PREFIX } },
      select: { id: true },
    }),
  ]);
  return {
    codeGraphPresent: codeGraph !== null,
    repoSourceIngested: repoSourceDoc !== null,
    fusedCodeRetrievalEnabled: cfg.getBool("ANALYSIS_FUSED_CODE_RETRIEVAL", true),
    schemaContextEnabled: cfg.getBool("ANALYSIS_SCHEMA_CONTEXT", true),
  };
}

/**
 * Mutable per-run accumulator. The orchestrator seeds it with the static facts
 * + which agents were requested, then updates the runtime-discovered fields
 * (`agentMode`, `quarantineFallbackUsed`, `skippedRepos`) as the run proceeds,
 * and finalizes it into an immutable {@link AnalysisCapability} for persistence.
 */
export interface CapabilityTracker {
  codeAnalysisRequested: boolean;
  databaseAnalysisRequested: boolean;
  codeGraphPresent: boolean;
  repoSourceIngested: boolean;
  fusedCodeRetrievalEnabled: boolean;
  schemaContextEnabled: boolean;
  agentMode: AnalysisAgentMode;
  quarantineFallbackUsed: boolean;
  skippedRepos: AnalysisSkippedRepo[];
  /**
   * #770 — the code agent ran and FAILED (persisted `agent_results.status =
   * 'failed'`). Set in the finalize step from the observable persisted outcome,
   * so every mode (agentic / requirement-grounded / single-shot) is covered by
   * one read rather than three catch blocks.
   */
  codeAgentFailed: boolean;
  /**
   * #769 — the code agent completed but could not serialize a JSON answer, so
   * its findings are partial/empty. Set by the orchestrator when an agentic pass
   * degrades.
   */
  codeAgentDegraded: boolean;
  /**
   * #773 — the code agent COMPLETED with a valid JSON answer, but its retrieval
   * fell below the evidence threshold (`retrieval-health.ts`): searches errored,
   * came back empty, or the investigation was cut short. Neither of the two flags
   * above fires for this case — which is why the reported incident run persisted
   * `reasons: []` while every "no evidence found" in it was unreliable. Set by the
   * orchestrator from the per-pass retrieval health.
   */
  codeRetrievalDegraded: boolean;
  /**
   * #777 — a repo CONNECTOR exists, but its clone is not on disk, so the agentic
   * code pass ran WITHOUT `read_file_slice` / `list_files` (code-graph + symbol
   * search only). Reduced investigation DEPTH — deliberately NOT folded into
   * `codeRetrievalDegraded`, which would tell the user to distrust verdicts that
   * are soundly grounded in a working code graph. Set by the orchestrator when it
   * resolves the clone dir for a pass.
   */
  repoCloneUnavailable: boolean;
  /**
   * #768 — the run carried free-text new requirements (`extraInstructions`). Set
   * by the orchestrator at mode-detection time.
   */
  newRequirementsProvided: boolean;
  /**
   * #768 — those new requirements parsed into candidates AND drove a code agent
   * running in a non-single-shot mode, i.e. they were genuinely analysed against
   * code. The positive counterpart to `new-requirements-not-analyzed`.
   */
  newRequirementsAnalyzed: boolean;
  /**
   * #1112 — INPUT-side coverage: what became of every requirement the user typed
   * into the free-text box (analyzed / merged into another / dropped, with a
   * reason). `null` when the run carried no free text. `newRequirementsAnalyzed`
   * above answers "did we run them?"; this answers "did we keep all of them?" —
   * the question #1101 showed nothing was asking.
   */
  requirementInputAccount: RequirementInputAccount | null;
}

/**
 * Seed a {@link CapabilityTracker} from the static project facts plus which
 * agents this run requested. `agentMode` starts at `single-shot` (the default
 * for a run with no code agent) and is overwritten once `detectAgentMode` runs.
 */
export function createCapabilityTracker(input: {
  static: AnalysisCapabilityPreview;
  codeAnalysisRequested: boolean;
  databaseAnalysisRequested: boolean;
}): CapabilityTracker {
  return {
    codeAnalysisRequested: input.codeAnalysisRequested,
    databaseAnalysisRequested: input.databaseAnalysisRequested,
    codeGraphPresent: input.static.codeGraphPresent,
    repoSourceIngested: input.static.repoSourceIngested,
    fusedCodeRetrievalEnabled: input.static.fusedCodeRetrievalEnabled,
    schemaContextEnabled: input.static.schemaContextEnabled,
    agentMode: "single-shot",
    quarantineFallbackUsed: false,
    skippedRepos: [],
    codeAgentFailed: false,
    codeAgentDegraded: false,
    codeRetrievalDegraded: false,
    repoCloneUnavailable: false,
    newRequirementsProvided: false,
    newRequirementsAnalyzed: false,
    requirementInputAccount: null,
  };
}

/**
 * #770 — read the code agent's OBSERVABLE persisted outcome for a run. Called
 * from the capability finalize step (after every agent has persisted its row),
 * so a code agent that ran and died is recorded as a degradation reason instead
 * of the run reporting a clean `reasons: []` agentic pass.
 */
export async function detectCodeAgentFailed(analysisId: string): Promise<boolean> {
  const row = await prisma.agentResult.findFirst({
    where: { analysisId, agentKey: "code" },
    select: { status: true },
    orderBy: { startedAt: "desc" },
  });
  return row?.status === "failed";
}

/**
 * Freeze a tracker into the immutable {@link AnalysisCapability} written to the
 * analysis metadata + emitted on the socket. Reasons are derived (never stored
 * ad hoc) so a stored record and a freshly-derived one always agree.
 */
export function finalizeCapability(tracker: CapabilityTracker): AnalysisCapability {
  return {
    codeAnalysisRequested: tracker.codeAnalysisRequested,
    databaseAnalysisRequested: tracker.databaseAnalysisRequested,
    codeGraphPresent: tracker.codeGraphPresent,
    agentMode: tracker.agentMode,
    repoSourceIngested: tracker.repoSourceIngested,
    fusedCodeRetrievalEnabled: tracker.fusedCodeRetrievalEnabled,
    schemaContextEnabled: tracker.schemaContextEnabled,
    quarantineFallbackUsed: tracker.quarantineFallbackUsed,
    skippedRepos: tracker.skippedRepos,
    codeAgentFailed: tracker.codeAgentFailed,
    codeAgentDegraded: tracker.codeAgentDegraded,
    codeRetrievalDegraded: tracker.codeRetrievalDegraded,
    repoCloneUnavailable: tracker.repoCloneUnavailable,
    newRequirementsProvided: tracker.newRequirementsProvided,
    newRequirementsAnalyzed: tracker.newRequirementsAnalyzed,
    // #1112 — omitted entirely (rather than written as null) when the run carried
    // no free text, so a plain run's persisted record is unchanged.
    ...(tracker.requirementInputAccount
      ? { requirementInputAccount: tracker.requirementInputAccount }
      : {}),
    reasons: deriveCapabilityReasons({
      codeAnalysisRequested: tracker.codeAnalysisRequested,
      databaseAnalysisRequested: tracker.databaseAnalysisRequested,
      codeGraphPresent: tracker.codeGraphPresent,
      repoSourceIngested: tracker.repoSourceIngested,
      fusedCodeRetrievalEnabled: tracker.fusedCodeRetrievalEnabled,
      schemaContextEnabled: tracker.schemaContextEnabled,
      agentMode: tracker.agentMode,
      quarantineFallbackUsed: tracker.quarantineFallbackUsed,
      skippedRepos: tracker.skippedRepos,
      codeAgentFailed: tracker.codeAgentFailed,
      codeAgentDegraded: tracker.codeAgentDegraded,
      codeRetrievalDegraded: tracker.codeRetrievalDegraded,
      repoCloneUnavailable: tracker.repoCloneUnavailable,
      newRequirementsProvided: tracker.newRequirementsProvided,
      requirementInputAccount: tracker.requirementInputAccount,
    }),
  };
}
