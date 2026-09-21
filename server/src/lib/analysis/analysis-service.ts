/**
 * Analysis persistence service (Phase 7 / #57).
 *
 * Responsibility: every Prisma read/write that touches an `Analysis`,
 * `AgentResult`, `Finding`, or `Requirement` row goes through here. The
 * orchestrator stays storage-agnostic; tests swap the service for a mock.
 *
 * Re-running an analysis NEVER mutates the previous run \u2014 a new `Analysis`
 * row is created so history is preserved (#57 AC1). Cascade-on-archive is
 * already wired via Prisma `onDelete: Cascade` on the project relation.
 */
import {
  type AnalysisAgentKey,
  type AnalysisCapability,
  type AnalysisAffectedCode,
  type AnalysisDatabaseAware,
  type AnalysisEscalation,
  type AnalysisRetrievalHealth,
  type AnalysisSnapshot,
  type AnalysisSpecialistAgentKey,
  type AgentFindingPayload,
  type AgentOutput,
  type Citation,
  type DocumentCitation,
  isCodeCitation,
  isDocumentCitation,
  formatCodeCitationLocator,
  type ContradictionScope,
  type CrossDocFinding,
  type CrossDocFindingKind,
  type CrossDocFindings,
  type ResolvedEvidenceRef,
  type FindingCategory,
  type FindingDerivation,
  type FindingSeverity,
  type FindingSupportPanel,
  findingSupportPanelSchema,
  type FindingFaithfulness,
  findingFaithfulnessSchema,
  // Epic #1107 (#1110) — the shared presentation seam's requirement rollup.
  summarizeSupportPanels,
  type FindingVerificationStatus,
  type RequirementCoverage,
  type RequirementPriority,
  type RequirementReviewStatus,
  type RequirementType,
  type RequirementVerdict,
  type SynthesisOutput,
  ANALYSIS_AGENT_KEYS,
  CONTRADICTION_SCOPES,
  CROSS_DOC_FINDING_KINDS,
  DEFAULT_FINDING_CONFIDENCE,
  FINDING_SEVERITIES,
  FINDING_VERIFICATION_STATUSES,
  MODEL_ASSERTABLE_FINDING_DERIVATIONS,
  REQUIREMENT_COVERAGES,
  REQUIREMENT_REVIEW_STATUSES,
  REQUIREMENT_VERDICTS,
  parseAcceptanceCriteria,
  type SynthesisDegradation,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import type { TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { isServerAuthored } from "./server-authored.js";
import { CODE_GRAPH_DOCUMENT_PREFIX } from "./fused-code-chunks.js";
import type { ToolCallTelemetry } from "./tool-telemetry.js";
import type {
  ClarificationApplication,
  StructuredRequirements,
  WebResearchResult,
} from "./types/requirements.js";

const log = createChildLogger("analysis-service");

/**
 * `Analysis.metadata.source` tags for rows that share the `Analysis` table but
 * are NOT user-facing LLM analysis runs. These background rows (code-graph
 * ingestion, opt-in doc-gen domain web research, etc.) carry zero tokens / no
 * findings, so {@link listAnalysesForProject} excludes them from the
 * analysis-history UI. Add new background tags here so the doc-gen / ingest
 * write sites and this filter stay in sync.
 */
export const BACKGROUND_ANALYSIS_SOURCES: ReadonlySet<string> = new Set([
  "code-graph-ingest",
  "docs-gen-domain-research",
]);

export interface CreateAnalysisInput {
  projectId: string;
  startedById: string;
  agentKeys: AnalysisSpecialistAgentKey[];
  documentIds?: string[];
  model?: string;
  /** Free-text new-requirements string (#905); persisted for regenerate parity. */
  extraInstructions?: string;
}

export interface PersistAgentResultInput {
  analysisId: string;
  agentKey: AnalysisAgentKey;
  status: "completed" | "failed" | "cancelled";
  output: AgentOutput | SynthesisOutput | null;
  errorMessage?: string | null;
  startedAt: Date;
  completedAt: Date;
  usage: TokenUsage;
  /**
   * Issue #741 (Epic #727) — persistence mode for the `(analysisId, agentKey)`
   * pair. `"replace"` (default) deletes any prior row so single-agent regenerate
   * (#57) leaves no orphans. `"append"` keeps prior rows so the multi-repo
   * resume endpoint MERGES a resumed connector's findings alongside the original
   * run's findings (both are read back by {@link readFlattenedFindings}) instead
   * of clobbering them.
   */
  mode?: "replace" | "append";
  /**
   * Issue #763 (Epic #727) — the RepoConnection this result was produced for, on
   * the multi-repo agentic `code` path. When set, `replace` mode scopes its
   * delete to `(analysisId, agentKey, connectorId)` so one repo's persist no
   * longer clobbers another repo's `code` AgentResult (the silent multi-repo
   * data-loss bug). Omit for single-repo/legacy callers and the non-code agents
   * (doc/synthesis/security) — they keep whole-`agentKey` replace semantics.
   */
  connectorId?: string;
  /**
   * P0 #774 — compact summary of the agent loop's tool calls (counts + error
   * counts + a bounded sample of the model-facing error text). Stored INSIDE the
   * existing `output` JSON blob as a `toolTelemetry` sibling key, so no schema
   * change is needed and every existing reader (which picks named keys out of
   * the blob) is unaffected. Set by the agentic code path; omitted elsewhere, in
   * which case the persisted blob is byte-identical to before.
   */
  toolTelemetry?: ToolCallTelemetry;
}

export interface PersistedAgentResult {
  id: string;
  agentKey: AnalysisAgentKey;
  findingIds: string[];
}

const isAgentOutput = (value: AgentOutput | SynthesisOutput | null): value is AgentOutput =>
  value !== null && Array.isArray((value as AgentOutput).findings);

export async function createAnalysis(input: CreateAnalysisInput) {
  return prisma.analysis.create({
    data: {
      projectId: input.projectId,
      startedById: input.startedById,
      status: "running",
      metadata: JSON.stringify({
        agentKeys: input.agentKeys,
        documentIds: input.documentIds ?? [],
        model: input.model ?? null,
        extraInstructions: input.extraInstructions ?? null,
      }),
    },
  });
}

/**
 * Epic #922 — additive enhancement data persisted into the analysis
 * `metadata` JSON blob (no schema migration). The clarification dialog (#926)
 * sources structured requirements from here, and the evidence review UI (#927)
 * reads `webResearch`. Merge semantics: only the provided keys are replaced.
 */
/**
 * Epic #202 (#216) — durable record of whether artifact promotion was blocked
 * by unresolved approval checkpoints. Persisted to `Analysis.metadata` so the
 * UI can surface the blocked state and the counts of outstanding approvals.
 */
export interface PromotionBlockedState {
  blocked: boolean;
  pendingCount: number;
  rejectedCount: number;
  /**
   * Issue #1104 (finding B) — how many synthesized requirements the gate is
   * holding back. The live incident reported a "completed" run with zero
   * requirements and no indication that 13 of them existed but were withheld;
   * this count is what makes "blocked" mean something to the user.
   */
  awaitingRequirementCount?: number;
  /** Issue #1104 — UI-ready one-line explanation of the gate. */
  reason?: string;
}

/** #256 — terminal promotion outcome surfaced to the UI alongside the marker. */
export type PromotionStatus = "allowed" | "blocked";

export interface AnalysisEnhancementPatch {
  enhancement?: { enableWebResearch: boolean; enableClarification: boolean };
  structuredRequirements?: StructuredRequirements;
  webResearch?: WebResearchResult;
  /** Epic #202 (#216) — promotion-gating state from the approval checkpoints. */
  promotionBlocked?: PromotionBlockedState;
  /** #256 — coarse promotion outcome; written in the same patch as the marker. */
  promotionStatus?: PromotionStatus;
  /**
   * Issue #773 — the run's code-retrieval health + searched-scope provenance.
   * Rides the metadata JSON blob (no migration), like the #733 capability record.
   */
  retrieval?: AnalysisRetrievalHealth;
  /**
   * Issue #1116 — what the last clarification-enrichment pass did with the
   * user's answers (how many reached a persisted requirement, how many could
   * not be attributed). Read by the UI so the user is told what their answers
   * do and do not affect.
   */
  clarificationApplication?: ClarificationApplication;
  /**
   * Issue #1117 (findings B + C) — set when synthesis fell back to the
   * deterministic clusterer. Absent on a healthy run, so its mere presence is
   * the signal. Without it a degraded run is indistinguishable from a good one
   * until somebody reads the persisted agent output by hand.
   */
  synthesisDegraded?: SynthesisDegradation;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function persistAnalysisEnhancement(
  id: string,
  patch: AnalysisEnhancementPatch,
): Promise<void> {
  const row = await prisma.analysis.findFirst({ where: { id }, select: { metadata: true } });
  const current = parseMetadata(row?.metadata ?? null);
  const next: Record<string, unknown> = { ...current };
  if (patch.enhancement !== undefined) next.enhancement = patch.enhancement;
  if (patch.structuredRequirements !== undefined) {
    next.structuredRequirements = patch.structuredRequirements;
  }
  if (patch.webResearch !== undefined) next.webResearch = patch.webResearch;
  if (patch.promotionBlocked !== undefined) next.promotionBlocked = patch.promotionBlocked;
  if (patch.promotionStatus !== undefined) next.promotionStatus = patch.promotionStatus;
  if (patch.retrieval !== undefined) next.retrieval = patch.retrieval;
  if (patch.clarificationApplication !== undefined) {
    next.clarificationApplication = patch.clarificationApplication;
  }
  if (patch.synthesisDegraded !== undefined) next.synthesisDegraded = patch.synthesisDegraded;
  await prisma.analysis.update({ where: { id }, data: { metadata: JSON.stringify(next) } });
}

/**
 * Issue #733 (Epic #725) — persist the structured analysis-capability record
 * into the `metadata.capability` JSON blob (additive, no schema migration).
 * Merge-preserving: only the `capability` key is (re)written, so it composes
 * with {@link persistAnalysisEnhancement}. Surfaced on the GET snapshot as the
 * typed `capability` field so the UI can render the degradation banner.
 */
export async function persistAnalysisCapability(
  id: string,
  capability: AnalysisCapability,
): Promise<void> {
  const row = await prisma.analysis.findFirst({ where: { id }, select: { metadata: true } });
  const next = { ...parseMetadata(row?.metadata ?? null), capability };
  await prisma.analysis.update({ where: { id }, data: { metadata: JSON.stringify(next) } });
}

/**
 * Issue #735 (Epic #726) — persist the deterministic requirement→code mapping
 * (`metadata.affectedCode`, additive, no schema migration). Merge-preserving:
 * only the `affectedCode` key is (re)written, so it composes with the capability
 * + enhancement writers. Surfaced on the GET snapshot as the typed
 * `affectedCode` field so the UI renders the per-candidate affected-code lists.
 */
export async function persistAnalysisAffectedCode(
  id: string,
  affectedCode: AnalysisAffectedCode,
): Promise<void> {
  const row = await prisma.analysis.findFirst({ where: { id }, select: { metadata: true } });
  const next = { ...parseMetadata(row?.metadata ?? null), affectedCode };
  await prisma.analysis.update({ where: { id }, data: { metadata: JSON.stringify(next) } });
}

/**
 * Issue #739 (Epic #727) — persist the per-requirement escalation decision
 * (`metadata.escalation`, additive, no schema migration). Merge-preserving: only
 * the `escalation` key is (re)written, so it composes with the capability +
 * affected-code + enhancement writers. Surfaced on the GET snapshot as the typed
 * `escalation` field so the UI renders the per-requirement depth indicator.
 */
export async function persistAnalysisEscalation(
  id: string,
  escalation: AnalysisEscalation,
): Promise<void> {
  const row = await prisma.analysis.findFirst({ where: { id }, select: { metadata: true } });
  const next = { ...parseMetadata(row?.metadata ?? null), escalation };
  await prisma.analysis.update({ where: { id }, data: { metadata: JSON.stringify(next) } });
}

/**
 * Epic #852 Phase 2b (#855) — persist the database-aware-analysis resolver's
 * decision for this run (`metadata.databaseAware`, additive, no schema
 * migration). Merge-preserving: only the `databaseAware` key is (re)written, so
 * it composes with the capability + affected-code + escalation writers.
 * Surfaced on the GET snapshot as the typed `databaseAware` field so the UI
 * (#859) and e2e (#861) can observe whether schema reasoning ran and WHY.
 */
export async function persistAnalysisDatabaseAware(
  id: string,
  databaseAware: AnalysisDatabaseAware,
): Promise<void> {
  const row = await prisma.analysis.findFirst({ where: { id }, select: { metadata: true } });
  const next = { ...parseMetadata(row?.metadata ?? null), databaseAware };
  await prisma.analysis.update({ where: { id }, data: { metadata: JSON.stringify(next) } });
}

/**
 * Epic #922 (#926) — server-sourced structured requirements for the
 * clarification dialog. Returns `null` when extraction never ran.
 */
export async function getStructuredRequirements(
  id: string,
): Promise<StructuredRequirements | null> {
  const row = await prisma.analysis.findFirst({ where: { id }, select: { metadata: true } });
  const meta = parseMetadata(row?.metadata ?? null);
  const value = meta.structuredRequirements;
  return value ? (value as StructuredRequirements) : null;
}

/**
 * Epic #204 (#222) — read the persisted web-research digests for the most
 * recently-completed analysis of a project, for injection into doc synthesis as
 * grounding evidence. Returns `null` when no analysis has web research.
 */
export async function getLatestWebResearch(projectId: string): Promise<WebResearchResult | null> {
  const rows = await prisma.analysis.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
    // Look back over at most the 10 most-recent analyses: web research is only
    // attached to some analyses, so we scan a small recent window to find the
    // latest one that carries it. The cap bounds the query (and the in-memory
    // scan below) so a project with a long analysis history can't load every row.
    take: 10,
  });
  for (const row of rows) {
    const meta = parseMetadata(row.metadata ?? null);
    const value = meta.webResearch;
    if (value && typeof value === "object") {
      return value as WebResearchResult;
    }
  }
  return null;
}

export async function markAnalysisCompleted(id: string, totals: TokenUsage): Promise<void> {
  await prisma.analysis.update({
    where: { id },
    data: {
      status: "completed",
      completedAt: new Date(),
      inputTokens: totals.promptTokens,
      outputTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
    },
  });
}

export async function markAnalysisFailed(
  id: string,
  errorMessage: string,
  totals: TokenUsage,
): Promise<void> {
  await prisma.analysis.update({
    where: { id },
    data: {
      status: "failed",
      completedAt: new Date(),
      errorMessage: errorMessage.slice(0, 4096),
      inputTokens: totals.promptTokens,
      outputTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
    },
  });
}

export async function markAnalysisCancelled(id: string, totals: TokenUsage): Promise<void> {
  await prisma.analysis.update({
    where: { id },
    data: {
      status: "cancelled",
      completedAt: new Date(),
      inputTokens: totals.promptTokens,
      outputTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
    },
  });
}

/**
 * Atomic finalize used by single-agent regenerate. Increments token columns
 * server-side via SQL `INCREMENT` so two concurrent regenerates cannot lose
 * tokens to a read/modify/write race. The status column is overwritten
 * because regenerate is gated on a terminal state, so the new outcome is the
 * authoritative one.
 */
export async function finalizeAnalysisDelta(input: {
  id: string;
  status: "completed" | "failed";
  delta: TokenUsage;
  errorMessage?: string | null;
}): Promise<void> {
  await prisma.analysis.update({
    where: { id: input.id },
    data: {
      status: input.status,
      completedAt: new Date(),
      inputTokens: { increment: input.delta.promptTokens },
      outputTokens: { increment: input.delta.completionTokens },
      totalTokens: { increment: input.delta.totalTokens },
      errorMessage: input.errorMessage ? input.errorMessage.slice(0, 4096) : null,
    },
  });
}

/**
 * Issue #1234 — resolve the provenance pair persisted on every agent finding.
 *
 * Epic #298 / #309 gave every `Finding` row a `derivation` + `confidence` pair,
 * but agent findings were written with the literals `"inferred"` / `0.7`, so
 * across a real run all 8 findings carried an identical pair and the badges
 * rendered a constant. Worse, `ambiguous` — the value the analysis page's
 * human-review affordance gates on — was unreachable.
 *
 * Two rules survive from the value being model-authored:
 *
 * 1. `extracted` is NOT model-assertable. It means "pulled straight from
 *    source/AST" and mandates confidence 1.0 (`createFindingSchema` refines on
 *    exactly that), which is a claim only the server can make. A model that
 *    emits it is coerced to `inferred`.
 * 2. A malformed value falls back; it never throws. `agentFindingPayloadSchema`
 *    already `.catch()`es these fields so a bad value cannot fail validation and
 *    discard a completed run (#1230), and this second pass keeps that guarantee
 *    for callers that build an `AgentOutput` without going through Zod.
 */
export function resolveFindingProvenance(finding: { derivation?: unknown; confidence?: unknown }): {
  derivation: FindingDerivation;
  confidence: number;
} {
  const derivation = (MODEL_ASSERTABLE_FINDING_DERIVATIONS as readonly string[]).includes(
    finding.derivation as string,
  )
    ? (finding.derivation as FindingDerivation)
    : "inferred";
  const raw = finding.confidence;
  const confidence =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1
      ? raw
      : DEFAULT_FINDING_CONFIDENCE;
  return { derivation, confidence };
}

export async function persistAgentResult(
  input: PersistAgentResultInput,
): Promise<PersistedAgentResult> {
  // Replace any prior AgentResult row for the same (analysisId, agentKey) pair
  // so single-agent regenerate (#57) doesn't leave orphan rows. `mode: "append"`
  // (#741 resume) skips the delete so resumed-repo findings merge rather than
  // clobber the original run's code findings.
  //
  // Issue #763 — when a `connectorId` is supplied (the multi-repo agentic `code`
  // path), the delete is SCOPED to that connector so persisting repo N's result
  // no longer deletes repo N-1's `code` row. Callers with no connector
  // (doc/synthesis/security agents, single-repo regenerate #57) keep the original
  // whole-`agentKey` replace.
  if ((input.mode ?? "replace") === "replace") {
    const existing = await prisma.agentResult.findFirst({
      where: {
        analysisId: input.analysisId,
        agentKey: input.agentKey,
        ...(input.connectorId ? { connectorId: input.connectorId } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      await prisma.agentResult.delete({ where: { id: existing.id } });
    }
  }

  // #774 — the loop's tool-call summary rides in the existing output JSON column
  // (no migration): a `toolTelemetry` sibling of the agent output's own keys.
  const outputJson = input.output
    ? JSON.stringify(
        input.toolTelemetry
          ? { ...input.output, toolTelemetry: input.toolTelemetry }
          : input.output,
      )
    : null;
  const created = await prisma.agentResult.create({
    data: {
      analysisId: input.analysisId,
      agentKey: input.agentKey,
      connectorId: input.connectorId ?? null,
      status: input.status,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      output: outputJson,
      errorMessage: input.errorMessage ?? null,
    },
  });

  const findingIds: string[] = [];
  let refusedMetrics = 0;
  if (isAgentOutput(input.output)) {
    for (const f of input.output.findings) {
      const provenance = resolveFindingProvenance(f);
      // #1318 — count the `faithfulness` values the server did not author, so
      // the refusal below is not silent. On the model-emitted path it means a
      // provider is filling in a server-owned field; on a future path that
      // COPIES the metric it would be a real measurement going missing, which
      // reads identically from the database and would otherwise be invisible.
      if (f.faithfulness != null && !isServerAuthored(f.faithfulness)) refusedMetrics += 1;
      const row = await prisma.finding.create({
        data: {
          agentResultId: created.id,
          category: f.category,
          severity: f.severity,
          title: f.title.slice(0, 255),
          body: f.body,
          evidence: JSON.stringify({
            citations: f.citations,
            tags: f.tags,
            // Epic #912 (#916/#920) — store the requirement linkage inside the
            // evidence blob so no DB migration is needed (retrieval-only change).
            requirementId: f.requirementId ?? null,
            // Issue #773 — the GATED per-finding verdict. Rides the same evidence
            // blob (no migration): `implemented` | `gap-confirmed` |
            // `could-not-verify`. Null for findings that make no requirement claim.
            verdict: f.verdict ?? null,
            // Epic #1107 (#1109) — the multi-lens panel's confidence signal, on
            // the same evidence blob (no migration). Written ONLY when a panel
            // actually ran, so a flag-off run persists a byte-identical blob to
            // a pre-#1109 run rather than gaining a `"supportPanel": null` key.
            ...(f.supportPanel ? { supportPanel: f.supportPanel } : {}),
            // Epic #1316 (#1318) — the claim-level faithfulness METRIC, on the
            // same evidence blob (no migration). Written ONLY when the metric
            // actually ran, so a flag-off run persists a byte-identical blob to
            // a pre-#1318 run rather than gaining a `"faithfulness": null` key.
            // Additive: nothing reads it back to decide a verdict.
            //
            // `isServerAuthored` is the load-bearing half. `faithfulness` is
            // server-owned, but `agentFindingPayloadSchema` accepts it from the
            // model on the plain-Zod path, and only two of this function's eight
            // `orchestrator.ts` call sites run a grader — `runOneAgent` persists
            // the `document`, `business` and `database` agents' output directly.
            // This is the one choke point all eight share, so the check lives
            // here rather than inside a grader most of them never reach.
            ...(isServerAuthored(f.faithfulness) ? { faithfulness: f.faithfulness } : {}),
          }),
          derivation: provenance.derivation,
          confidence: provenance.confidence,
          // Epic #727 (#740) — persist the deterministic verifier verdict set by
          // the orchestrator after the #734 grounding gate. Null for findings
          // that made no code-evidence claim (and for non-agent-output callers).
          verificationStatus: f.verificationStatus ?? null,
        },
      });
      findingIds.push(row.id);
    }
  }
  if (refusedMetrics > 0) {
    // Counts and the run identity only — never the finding text.
    log.warn("Refused faithfulness metrics the server did not author", {
      analysisId: input.analysisId,
      agentKey: input.agentKey,
      refusedMetrics,
      findings: findingIds.length,
    });
  }
  return { id: created.id, agentKey: input.agentKey, findingIds };
}

export interface PersistRequirementsInput {
  analysisId: string;
  projectId: string;
  synthesis: SynthesisOutput;
  /**
   * Map from synthesis evidence indexes (the [N] prefixes the model saw) to
   * the Finding row ids that produced them. Used to populate the Requirement
   * \u2192 Finding traceability link via the `labels` JSON.
   */
  findingIdsByIndex: string[];
  /**
   * Epic #726 (#736) \u2014 deterministic coverage label per synthesized
   * requirement, index-aligned with `synthesis.requirements`. Optional so
   * legacy/other callers persist `null`.
   */
  coverages?: RequirementCoverage[];
  /**
   * Issue #773 — deterministic three-state verdict per synthesized requirement,
   * index-aligned with `synthesis.requirements`. Optional so legacy/other callers
   * persist `null` (rendered as a neutral state).
   */
  verdicts?: Array<RequirementVerdict | null>;
}

export async function persistRequirements(input: PersistRequirementsInput): Promise<string[]> {
  // Drop any prior synthesis output \u2014 #57 says re-runs replace the
  // requirement set for the same Analysis.
  await prisma.requirement.deleteMany({ where: { analysisId: input.analysisId } });

  const ids: string[] = [];
  for (let idx = 0; idx < input.synthesis.requirements.length; idx++) {
    const r = input.synthesis.requirements[idx];
    const evidenceIds = r.evidenceFindingIndexes
      .map((i) => input.findingIdsByIndex[i])
      .filter((id): id is string => Boolean(id));
    const labels = Array.from(new Set([...r.labels, ...evidenceIds.map((id) => `finding:${id}`)]));
    const row = await prisma.requirement.create({
      data: {
        analysisId: input.analysisId,
        projectId: input.projectId,
        type: r.type,
        title: r.title.slice(0, 255),
        body: r.body,
        priority: r.priority,
        labels: JSON.stringify(labels),
        // Issue #1096 — the synthesis agent's own criteria, kept as structured
        // data instead of being collapsed into `body`. An empty array is
        // preserved as-is: downstream says "none were derived" rather than
        // substituting a placeholder.
        acceptanceCriteria: JSON.stringify(r.acceptanceCriteria ?? []),
        storyPoints: r.storyPoints ?? null,
        // Epic #726 (#736) — persist the deterministic coverage label so the
        // API/UI read a queryable field, not prose. Null when the caller did
        // not compute one (non-synthesis callers).
        coverage: input.coverages?.[idx] ?? null,
        // Issue #773 — persist the verdict alongside coverage. Coverage says what
        // evidence exists; the verdict says whether we may tell the user to build it.
        verdict: input.verdicts?.[idx] ?? null,
      },
    });
    ids.push(row.id);
  }
  return ids;
}

/**
 * Epic #203 (#221) — replace the cross-document detection findings for an
 * analysis. Re-running detection deletes the prior set so history mirrors the
 * #57 "re-runs replace" semantics used for requirements. Returns the persisted
 * row ids in insertion order.
 */
export async function persistCrossDocFindings(input: {
  analysisId: string;
  findings: CrossDocFinding[];
}): Promise<string[]> {
  await prisma.crossDocFinding.deleteMany({ where: { analysisId: input.analysisId } });
  const ids: string[] = [];
  for (const f of input.findings) {
    const row = await prisma.crossDocFinding.create({
      data: {
        analysisId: input.analysisId,
        kind: f.kind,
        severity: f.severity,
        title: f.title.slice(0, 255),
        detail: f.detail,
        evidenceIds: JSON.stringify(f.evidenceIds ?? []),
        scope: f.scope ?? null,
      },
    });
    ids.push(row.id);
  }
  return ids;
}

const CROSS_DOC_KIND_SET = new Set<string>(CROSS_DOC_FINDING_KINDS);
const SCOPE_SET = new Set<string>(CONTRADICTION_SCOPES);
const SEVERITY_SET = new Set<string>(FINDING_SEVERITIES);

function parseEvidenceIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Issue #448 (epic #407) — PURE mapper (no DB): turn a single `evidenceId`
 * (an agent `Finding` row id) plus its resolved `Finding` and first `Citation`
 * into a readable {@link ResolvedEvidenceRef}, or `undefined` when the id is
 * unresolvable (legacy / deleted finding, or a finding with no citation) so the
 * client degrades to the raw id.
 *
 * OWASP / no-leak: only the citation `filename` (or the `documentId` fallback)
 * and the `chunkIndex` are surfaced. The finding body, citation snippet, and
 * any storage path are deliberately NOT read here.
 */
export function toResolvedEvidenceRef(
  evidenceId: string,
  citation?: Citation,
  docNameById?: ReadonlyMap<string, string>,
): ResolvedEvidenceRef | undefined {
  if (!citation) return undefined;
  // #734 — a CODE citation resolves directly to its `filePath:startLine-endLine`
  // locator (chat #715 format); no Document lookup is possible or needed.
  if (isCodeCitation(citation)) {
    const ref: ResolvedEvidenceRef = {
      chunkId: evidenceId,
      sourceLabel: formatCodeCitationLocator(citation),
      sourceId: citation.filePath,
      line: citation.startLine,
    };
    return ref;
  }
  // sourceLabel prefers the citation's inline human filename; when absent we
  // resolve the documentId → the Document's filename (#448 — the agent does not
  // always record the inline filename on a citation even when the Document IS
  // named). We deliberately do NOT fall back to the raw documentId cuid: that
  // just swaps a chunk cuid for a document cuid and is still unreadable. An
  // unresolved source omits the ref so the client degrades to the raw id. Only
  // the filename + chunkIndex are surfaced — no snippet/body/storage path
  // (OWASP no-leak).
  const resolvedName = citation.documentId ? docNameById?.get(citation.documentId) : undefined;
  const sourceLabel = citation.filename?.trim() || resolvedName?.trim() || undefined;
  if (!sourceLabel) return undefined;
  const ref: ResolvedEvidenceRef = { chunkId: evidenceId, sourceLabel };
  if (citation.documentId) ref.sourceId = citation.documentId;
  if (typeof citation.chunkIndex === "number" && citation.chunkIndex >= 0) {
    ref.line = citation.chunkIndex;
  }
  return ref;
}

/**
 * Epic #203 (#221) — read the persisted cross-doc findings for an analysis,
 * normalised into the surfaced {@link CrossDocFindings} bundle. Returns `null`
 * when detection never ran (no rows), so the snapshot field stays nullable for
 * pre-#203 analyses.
 *
 * Issue #448 (epic #407) — read-time evidence enrichment: each finding's
 * `evidenceIds` are agent `Finding` row ids. We collect ALL of them across the
 * cross-doc findings and resolve them in ONE batched `finding.findMany` (no
 * N+1), mapping each to a readable {@link ResolvedEvidenceRef} via the pure
 * {@link toResolvedEvidenceRef}. The original `evidenceIds` are preserved as the
 * graceful-degradation fallback; ids that do not resolve simply emit no
 * enriched ref. Because this is read-time, it works for already-persisted
 * findings with no migration / re-run.
 */
export async function readCrossDocFindings(analysisId: string): Promise<CrossDocFindings | null> {
  const rows = await prisma.crossDocFinding.findMany({
    where: { analysisId },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return null;

  const parsedEvidenceIds = rows.map((r) => parseEvidenceIds(r.evidenceIds));

  // Collect every distinct evidenceId across all findings → ONE batched query.
  const allIds = [...new Set(parsedEvidenceIds.flat())];
  const refById = new Map<string, ResolvedEvidenceRef>();
  if (allIds.length > 0) {
    const findingRows = await prisma.finding.findMany({
      where: { id: { in: allIds } },
      select: { id: true, title: true, evidence: true },
    });
    const firstCitations = findingRows.map((f) => parseEvidence(f.evidence).citations[0]);
    // #448 — resolve documentId → filename in ONE batched query for the
    // citations that carry a documentId but NO inline filename, so an evidence
    // chip shows the document's real name instead of a raw document cuid.
    const docIds = [
      ...new Set(
        firstCitations
          .filter(
            (c): c is DocumentCitation =>
              !!c &&
              isDocumentCitation(c) &&
              !c.filename?.trim() &&
              !!c.documentId?.trim() &&
              // #734 — a synthetic `code-graph:<symbolId>` id is NOT a Document
              // row; never chase it through `document.findMany`.
              !c.documentId.startsWith(CODE_GRAPH_DOCUMENT_PREFIX),
          )
          .map((c) => c.documentId.trim()),
      ),
    ];
    const docNameById = new Map<string, string>();
    if (docIds.length > 0) {
      const docs = await prisma.document.findMany({
        where: { id: { in: docIds } },
        select: { id: true, filename: true },
      });
      for (const d of docs) if (d.filename?.trim()) docNameById.set(d.id, d.filename);
    }
    findingRows.forEach((f, idx) => {
      const ref = toResolvedEvidenceRef(f.id, firstCitations[idx], docNameById);
      if (ref) refById.set(f.id, ref);
    });
  }

  const findings: CrossDocFinding[] = rows.map((r, i) => {
    const evidenceIds = parsedEvidenceIds[i]!;
    const evidence = evidenceIds
      .map((eid) => refById.get(eid))
      .filter((ref): ref is ResolvedEvidenceRef => ref !== undefined);
    return {
      id: r.id,
      kind: (CROSS_DOC_KIND_SET.has(r.kind) ? r.kind : "contradiction") as CrossDocFindingKind,
      severity: (SEVERITY_SET.has(r.severity) ? r.severity : "medium") as FindingSeverity,
      title: r.title,
      detail: r.detail,
      evidenceIds,
      // ADDITIVE: omit entirely when nothing resolved so the client degrades to
      // the raw ids rather than receiving an empty array it must special-case.
      ...(evidence.length > 0 ? { evidence } : {}),
      scope: r.scope && SCOPE_SET.has(r.scope) ? (r.scope as ContradictionScope) : null,
    };
  });
  const contradictionCount = findings.filter((f) => f.kind === "contradiction").length;
  return {
    findings,
    contradictionCount,
    completenessGapCount: findings.length - contradictionCount,
    generatedAt: rows[rows.length - 1]!.createdAt.toISOString(),
  };
}

export async function listAnalysesForProject(projectId: string) {
  const rows = await prisma.analysis.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      projectId: true,
      status: true,
      startedAt: true,
      completedAt: true,
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
      errorMessage: true,
      metadata: true,
    },
  });
  // Exclude background rows (code-graph ingest, opt-in doc-gen domain research,
  // etc.) that share this table but are not LLM analysis runs and would appear
  // as "0 tok / No findings". See BACKGROUND_ANALYSIS_SOURCES.
  return rows.filter((row) => {
    if (!row.metadata) return true;
    try {
      const meta = JSON.parse(row.metadata) as { source?: string };
      return meta.source === undefined || !BACKGROUND_ANALYSIS_SOURCES.has(meta.source);
    } catch {
      return true;
    }
  });
}

export async function getAnalysisSnapshot(id: string): Promise<AnalysisSnapshot | null> {
  const row = await prisma.analysis.findFirst({
    where: { id, deletedAt: null },
    include: {
      agentResults: {
        include: { findings: true },
        orderBy: { startedAt: "asc" },
      },
      requirements: {
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!row) return null;
  const crossDocFindings = await readCrossDocFindings(id);
  return toSnapshot(row, crossDocFindings);
}

export async function updateRequirementRow(input: {
  /** Scope the lookup so PATCH /:id/requirements/:reqId can't be used cross-analysis (IDOR). */
  analysisId: string;
  requirementId: string;
  patch: {
    title?: string;
    body?: string;
    priority?: RequirementPriority;
    type?: RequirementType;
    labels?: string[];
    storyPoints?: number | null;
    reviewStatus?: RequirementReviewStatus;
  };
}) {
  const existing = await prisma.requirement.findFirst({
    where: {
      id: input.requirementId,
      analysisId: input.analysisId,
      deletedAt: null,
    },
  });
  if (!existing) return null;

  const data: Record<string, unknown> = {};
  if (input.patch.title !== undefined) data.title = input.patch.title.slice(0, 255);
  if (input.patch.body !== undefined) data.body = input.patch.body;
  if (input.patch.priority !== undefined) data.priority = input.patch.priority;
  if (input.patch.type !== undefined) data.type = input.patch.type;
  if (input.patch.storyPoints !== undefined) data.storyPoints = input.patch.storyPoints;

  // Review status is now a typed column (#M4). We still strip any legacy
  // `review:*` labels so the JSON blob stays clean.
  let labels = parseLabels(existing.labels);
  if (input.patch.labels) {
    labels = mergeLabelsPreservingMeta(input.patch.labels, labels);
  }
  labels = labels.filter((l) => !l.startsWith("review:"));
  if (input.patch.reviewStatus !== undefined) {
    data.reviewStatus = input.patch.reviewStatus;
  }
  data.labels = JSON.stringify(labels);
  return prisma.requirement.update({ where: { id: input.requirementId }, data });
}

/**
 * Issue #176 / #178 — load a single finding scoped to its analysis + project.
 *
 * The query joins `Finding → AgentResult → Analysis → Project` so a finding can
 * only be read through the analysis (and project) it actually belongs to. A
 * mismatched `analysisId`/`projectId`/`findingId` returns `null` (the caller
 * maps that to 404) — never leaking the difference between "does not exist" and
 * "belongs to someone else" (IDOR defence).
 */
export async function loadFindingForDeepDive(input: {
  projectId: string;
  analysisId: string;
  findingId: string;
}): Promise<{
  id: string;
  title: string;
  body: string;
  category: FindingCategory;
  severity: FindingSeverity;
  agentKey: AnalysisAgentKey;
  citations: Citation[];
  requirementId: string | null;
  projectName: string;
} | null> {
  const row = await prisma.finding.findFirst({
    where: {
      id: input.findingId,
      agentResult: {
        analysis: {
          id: input.analysisId,
          deletedAt: null,
          project: { id: input.projectId, deletedAt: null },
        },
      },
    },
    include: {
      agentResult: {
        select: { agentKey: true, analysis: { select: { project: { select: { name: true } } } } },
      },
    },
  });
  // #1330 (ADR 0011) — `agentResultId` is nullable, so `agentResult` is too.
  // A finding materialised from a scan finding has none and is deliberately NOT
  // publishable through the analysis path: it has no analysis, no project name
  // and no agent key to report. The `where` above already excludes it; this is
  // the fail-CLOSED narrowing that keeps tsc's proof of that honest.
  if (!row?.agentResult) return null;

  const ev = parseEvidence(row.evidence);
  const agentKey = SAFE_AGENT_KEYS.has(row.agentResult.agentKey)
    ? (row.agentResult.agentKey as AnalysisAgentKey)
    : "code";

  return {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category as FindingCategory,
    severity: row.severity as FindingSeverity,
    agentKey,
    citations: ev.citations,
    requirementId: ev.requirementId,
    projectName: row.agentResult.analysis.project.name,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

const SAFE_AGENT_KEYS = new Set<string>(ANALYSIS_AGENT_KEYS);

function parseLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function mergeLabelsPreservingMeta(next: string[], prev: string[]): string[] {
  const meta = prev.filter((l) => l.startsWith("review:") || l.startsWith("finding:"));
  const cleaned = next.filter((l) => !l.startsWith("review:") && !l.startsWith("finding:"));
  return [...new Set([...cleaned, ...meta])];
}

const EMPTY_EVIDENCE = {
  citations: [] as Citation[],
  tags: [] as string[],
  requirementId: null as string | null,
  verdict: null as RequirementVerdict | null,
  supportPanel: null as FindingSupportPanel | null,
  faithfulness: null as FindingFaithfulness | null,
};

function parseEvidence(raw: string | null): typeof EMPTY_EVIDENCE {
  if (!raw) return { ...EMPTY_EVIDENCE };
  try {
    const obj = JSON.parse(raw) as {
      citations?: Citation[];
      tags?: string[];
      requirementId?: unknown;
      verdict?: unknown;
      supportPanel?: unknown;
      faithfulness?: unknown;
    };
    return {
      citations: Array.isArray(obj.citations) ? obj.citations : [],
      tags: Array.isArray(obj.tags) ? obj.tags : [],
      requirementId: typeof obj.requirementId === "string" ? obj.requirementId : null,
      // Issue #773 — the gated verdict. Unknown / legacy values collapse to null
      // (a neutral, badge-free state) rather than leaking a bad label to the UI.
      verdict: coerceVerdict(obj.verdict),
      // Epic #1107 (#1109) — the panel signal, validated on the way OUT as well
      // as in: a blob written by an older/newer shape reads as "no panel" rather
      // than reaching the UI half-formed. Absent for every flag-off run.
      supportPanel: coerceSupportPanel(obj.supportPanel),
      // Epic #1316 (#1318) — the claim-level faithfulness metric, validated on
      // the way OUT as well as in. A blob written by an older or newer shape
      // reads as "not measured" rather than reaching the UI half-formed.
      faithfulness: coerceFaithfulness(obj.faithfulness),
    };
  } catch {
    return { ...EMPTY_EVIDENCE };
  }
}

/**
 * Epic #1107 (#1109) — coerce a persisted panel blob into the validated shape.
 * Anything that does not parse reads as "the panel did not run", which is the
 * same neutral state as a pre-#1109 row.
 */
function coerceSupportPanel(value: unknown): FindingSupportPanel | null {
  if (!value) return null;
  const parsed = findingSupportPanelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Epic #1316 (#1318) — coerce a persisted faithfulness blob into the validated
 * shape. Anything that does not parse reads as "the metric did not run", the
 * same neutral state as a pre-#1318 row.
 *
 * The `score` INSIDE a valid blob may legitimately be `0` — a finding the judge
 * scored and found wholly unsupported, which is the worst result the metric can
 * report and the one most worth keeping. Nothing on this path may test the blob
 * or its score for truthiness; the explicit null/undefined check says so.
 */
function coerceFaithfulness(value: unknown): FindingFaithfulness | null {
  if (value === null || value === undefined) return null;
  const parsed = findingFaithfulnessSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Issue #773 — coerce a persisted verdict string into the enum. Unknown / legacy
 * / null values read as "no verdict".
 */
function coerceVerdict(value: unknown): RequirementVerdict | null {
  return REQUIREMENT_VERDICTS.includes(value as RequirementVerdict)
    ? (value as RequirementVerdict)
    : null;
}

function parseAgentOutputBlob(raw: string | null): { summary: string | null; notes: string[] } {
  if (!raw) return { summary: null, notes: [] };
  try {
    const obj = JSON.parse(raw) as { summary?: unknown; notes?: unknown };
    return {
      summary: typeof obj.summary === "string" ? obj.summary : null,
      notes: Array.isArray(obj.notes)
        ? obj.notes.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return { summary: null, notes: [] };
  }
}

interface AnalysisRowWithIncludes {
  id: string;
  projectId: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  errorMessage: string | null;
  metadata: string | null;
  agentResults: Array<{
    id: string;
    agentKey: string;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
    output: string | null;
    errorMessage: string | null;
    findings: Array<{
      id: string;
      category: string;
      severity: string;
      title: string;
      body: string;
      evidence: string | null;
      derivation: string;
      confidence: number;
      /**
       * #1330 (ADR 0011) — nullable on the COLUMN since scan-finding
       * materialisation, which sets `scanFindingId` instead. A finding reached
       * through `agentResults.findings` is by construction a child of the
       * enclosing agent result, so `toSnapshot` resolves it to that row's id
       * rather than widening the public snapshot contract.
       */
      agentResultId: string | null;
      verificationStatus: string | null;
    }>;
  }>;
  requirements: Array<{
    id: string;
    type: string;
    title: string;
    body: string;
    priority: string;
    labels: string;
    storyPoints: number | null;
    reviewStatus?: string | null;
    coverage?: string | null;
    verdict?: string | null;
    /** Issue #1096 — JSON array column; optional so pre-#1096 fixtures still type. */
    acceptanceCriteria?: string | null;
    version: number;
  }>;
}

function toSnapshot(
  row: AnalysisRowWithIncludes,
  crossDocFindings: CrossDocFindings | null = null,
): AnalysisSnapshot {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  const agents = row.agentResults
    .filter((a) => SAFE_AGENT_KEYS.has(a.agentKey))
    .map((a) => {
      const blob = parseAgentOutputBlob(a.output);
      return {
        agentKey: a.agentKey as AnalysisSnapshot["agents"][number]["agentKey"],
        status: a.status as AnalysisSnapshot["agents"][number]["status"],
        startedAt: a.startedAt.toISOString(),
        completedAt: a.completedAt ? a.completedAt.toISOString() : null,
        summary: blob.summary,
        notes: blob.notes,
        errorMessage: a.errorMessage,
        findings: a.findings.map((f) => {
          const ev = parseEvidence(f.evidence);
          return {
            id: f.id,
            category: f.category as FindingCategory,
            severity: f.severity as FindingSeverity,
            title: f.title,
            body: f.body,
            tags: ev.tags,
            citations: ev.citations,
            // Epic #298 / #312 — provenance fields surface on the snapshot
            // so the UI can render the DerivationBadge and link the
            // INFERRED tooltip back to the originating agent run.
            derivation: f.derivation as FindingDerivation,
            confidence: f.confidence,
            // #1330 — see the nullability note on the row type. This is a
            // narrowing (the finding was READ through `a.findings`), not a
            // fabricated id.
            agentResultId: f.agentResultId ?? a.id,
            // Epic #912 (#916/#920) — requirement linkage for the UI.
            requirementId: ev.requirementId,
            // Epic #727 (#740) — verifier verdict for the UI badge + filter.
            verificationStatus: coerceVerificationStatus(f.verificationStatus),
            // Issue #773 — the finding's gated three-state verdict.
            verdict: ev.verdict,
            // Epic #1107 (#1109) — the multi-lens panel's confidence signal.
            // Null for every flag-off run and every pre-#1109 row; A2 (#1110)
            // renders it, and must render `no-signal` distinctly from `low`.
            supportPanel: ev.supportPanel,
            // Epic #1316 (#1318) — the claim-level faithfulness metric, on the
            // same [0,1] scale docs-gen reports. Null for every flag-off run and
            // every pre-#1318 row; `score: null` means UNVERIFIABLE and must
            // never render as a bad score.
            faithfulness: ev.faithfulness,
          };
        }),
      };
    });
  // Epic #1107 (#1110) — index the panel signal by finding id so each
  // requirement can be rolled up from the findings it was synthesised from. Both
  // sides of this join are already on the response being built, so the UI gets
  // the dissent reasoning with no second request and no database round-trip.
  const panelByFindingId = new Map<
    string,
    { title: string; supportPanel: FindingSupportPanel | null }
  >();
  for (const a of agents) {
    for (const f of a.findings) {
      panelByFindingId.set(f.id, { title: f.title, supportPanel: f.supportPanel });
    }
  }
  const requirements = row.requirements.map((r) => {
    const labels = parseLabels(r.labels);
    const reviewLabel = labels.find((l) => l.startsWith("review:"));
    // Prefer the typed column (#M4); fall back to the legacy `review:*`
    // label so rows written before the migration still parse.
    const fromColumn = r.reviewStatus as RequirementReviewStatus | null | undefined;
    const fromLabel = reviewLabel
      ? (reviewLabel.slice("review:".length) as RequirementReviewStatus)
      : null;
    const candidate = fromColumn ?? fromLabel ?? "draft";
    const reviewStatus: RequirementReviewStatus = REQUIREMENT_REVIEW_STATUSES.includes(candidate)
      ? candidate
      : "draft";
    const evidenceFindingIds = labels
      .filter((l) => l.startsWith("finding:"))
      .map((l) => l.slice("finding:".length));
    const cleanedLabels = labels.filter(
      (l) => !l.startsWith("review:") && !l.startsWith("finding:"),
    );
    // Epic #726 (#736) — surface the deterministic coverage label. Unknown /
    // legacy values (or a pre-#736 null) collapse to null so the UI renders the
    // neutral state rather than an unrecognized badge.
    const coverage: RequirementCoverage | null = REQUIREMENT_COVERAGES.includes(
      r.coverage as RequirementCoverage,
    )
      ? (r.coverage as RequirementCoverage)
      : null;
    return {
      id: r.id,
      type: r.type as RequirementType,
      title: r.title,
      body: r.body,
      priority: r.priority as RequirementPriority,
      labels: cleanedLabels,
      storyPoints: r.storyPoints,
      reviewStatus,
      evidenceFindingIds,
      coverage,
      // Issue #773 — the deterministic three-state verdict. Null on pre-#773 rows
      // and on runs with no code agent, so the UI renders a neutral state.
      verdict: coerceVerdict(r.verdict),
      // Issue #1096 — the requirement's own acceptance criteria, so the UI and
      // the issue-draft generator read the same structured data instead of
      // re-deriving (or faking) them.
      acceptanceCriteria: parseAcceptanceCriteria(r.acceptanceCriteria),
      // Epic #34 (AC2) — surface the optimistic-lock version so the edit form
      // can submit the version it rendered and reliably 409 on a stale form.
      version: r.version,
      // Epic #1107 (#1110) — the panel rollup: worst JUDGED label across the
      // requirement's evidence findings, plus each dissenting lens's own reason
      // and locator. Null when no linked finding carried a panel (every flag-off
      // and pre-#1109 run), so the UI renders exactly as it did before.
      supportConfidence: summarizeSupportPanels(
        evidenceFindingIds
          .map((id) => panelByFindingId.get(id))
          .filter((f): f is { title: string; supportPanel: FindingSupportPanel | null } =>
            Boolean(f),
          ),
      ),
    };
  });

  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as AnalysisSnapshot["status"],
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    errorMessage: row.errorMessage,
    metadata,
    agents,
    requirements,
    crossDocFindings,
    // Issue #733 — surface the persisted capability record as a typed field so
    // the UI reads it without re-parsing `metadata`. Null on pre-#733 runs.
    capability: extractCapability(metadata),
    // Issue #735 — surface the deterministic requirement→code mapping as a typed
    // field. Null on runs with no new requirements / no mapping / pre-#735 runs.
    affectedCode: extractAffectedCode(metadata),
    // Issue #739 — surface the per-requirement escalation decision as a typed
    // field. Null on runs with the policy disabled / no agentic pass / pre-#739.
    escalation: extractEscalation(metadata),
    // Issue #773 — the run's code-retrieval health + searched-scope provenance.
    retrieval: extractRetrieval(metadata),
    // Issue #855 (Epic #852) — the database-aware-analysis resolver's decision
    // for this run. Null when the resolver was never applicable or pre-#855.
    databaseAware: extractDatabaseAware(metadata),
  };
}

/**
 * Issue #855 (Epic #852) — pull the persisted {@link AnalysisDatabaseAware} out
 * of the metadata blob. Returns null when absent (pre-#855 runs, or a run where
 * neither the code nor database agent ran) or malformed, so the UI renders
 * nothing rather than a stale/garbled decision.
 */
function extractDatabaseAware(
  metadata: Record<string, unknown> | null,
): AnalysisDatabaseAware | null {
  const value = metadata?.databaseAware;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as AnalysisDatabaseAware).reason === "string" &&
    typeof (value as AnalysisDatabaseAware).enabled === "boolean"
  ) {
    return value as AnalysisDatabaseAware;
  }
  return null;
}

/**
 * Issue #773 — pull the persisted {@link AnalysisRetrievalHealth} out of the
 * metadata blob. Null when the run had no agentic code pass (or predates #773),
 * so the UI renders no searched-scope panel rather than an empty one.
 */
function extractRetrieval(
  metadata: Record<string, unknown> | null,
): AnalysisRetrievalHealth | null {
  const value = metadata?.retrieval;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as AnalysisRetrievalHealth).successfulSearches === "number"
  ) {
    return value as AnalysisRetrievalHealth;
  }
  return null;
}

/**
 * Issue #739 — pull the persisted {@link AnalysisEscalation} out of the metadata
 * blob. Returns null when absent or malformed, so the UI renders nothing for a
 * run that never scored requirements for escalation.
 */
function extractEscalation(metadata: Record<string, unknown> | null): AnalysisEscalation | null {
  const value = metadata?.escalation;
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as AnalysisEscalation).requirements)
  ) {
    return value as AnalysisEscalation;
  }
  return null;
}

/**
 * Issue #735 — pull the persisted {@link AnalysisAffectedCode} out of the
 * metadata blob. Returns null when absent or malformed, so the UI renders
 * nothing for a run that never mapped new requirements to code.
 */
function extractAffectedCode(
  metadata: Record<string, unknown> | null,
): AnalysisAffectedCode | null {
  const value = metadata?.affectedCode;
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as AnalysisAffectedCode).candidates)
  ) {
    return value as AnalysisAffectedCode;
  }
  return null;
}

/**
 * Issue #733 — pull the persisted {@link AnalysisCapability} out of the metadata
 * blob. Returns null when absent (pre-#733 runs) or malformed, so the UI never
 * shows a banner for a run that has no record.
 */
function extractCapability(metadata: Record<string, unknown> | null): AnalysisCapability | null {
  const value = metadata?.capability;
  if (value && typeof value === "object" && Array.isArray((value as AnalysisCapability).reasons)) {
    return value as AnalysisCapability;
  }
  return null;
}

/**
 * Issue #741 (Epic #727) — read the persisted {@link AnalysisCapability} for an
 * analysis without loading the full snapshot. Used by the multi-repo resume
 * pre-flight to discover which connectors were dropped for budget. Returns null
 * for pre-#733 runs (no record) or a malformed blob.
 */
export async function getAnalysisCapability(
  analysisId: string,
): Promise<AnalysisCapability | null> {
  const row = await prisma.analysis.findFirst({
    where: { id: analysisId, deletedAt: null },
    select: { metadata: true },
  });
  if (!row) return null;
  return extractCapability(parseMetadata(row.metadata ?? null));
}

/**
 * Issue #855 (Epic #852) — read the persisted {@link AnalysisDatabaseAware}
 * decision for an analysis without loading the full snapshot (mirrors
 * {@link getAnalysisCapability}). Returns null for pre-#855 runs (no record),
 * a run where the resolver was never applicable, or a malformed blob.
 */
export async function getAnalysisDatabaseAware(
  analysisId: string,
): Promise<AnalysisDatabaseAware | null> {
  const row = await prisma.analysis.findFirst({
    where: { id: analysisId, deletedAt: null },
    select: { metadata: true },
  });
  if (!row) return null;
  return extractDatabaseAware(parseMetadata(row.metadata ?? null));
}

export interface FlatFindingFromDb extends AgentFindingPayload {
  agentKey: AnalysisAgentKey;
  findingId: string;
}

/**
 * Epic #727 (#740) — coerce the free-form `findings.verificationStatus` column
 * into the enum. Unknown / legacy / null values collapse to `null` so a row
 * written before #740 (or with an unrecognised value) reads as "no verdict"
 * rather than throwing or leaking a bad label into synthesis / the UI.
 */
function coerceVerificationStatus(value: unknown): FindingVerificationStatus | null {
  return FINDING_VERIFICATION_STATUSES.includes(value as FindingVerificationStatus)
    ? (value as FindingVerificationStatus)
    : null;
}

/**
 * Read the persisted findings for an analysis flattened into the shape the
 * synthesis runner expects. Used by single-agent regenerate so we can re-run
 * synthesis without keeping the whole pipeline in memory.
 */
export async function readFlattenedFindings(analysisId: string): Promise<FlatFindingFromDb[]> {
  const rows = await prisma.agentResult.findMany({
    where: {
      analysisId,
      agentKey: { in: [...ANALYSIS_AGENT_KEYS].filter((k) => k !== "synthesis") },
    },
    include: { findings: true },
    orderBy: { startedAt: "asc" },
  });
  const out: FlatFindingFromDb[] = [];
  for (const r of rows) {
    for (const f of r.findings) {
      const ev = parseEvidence(f.evidence);
      out.push({
        agentKey: r.agentKey as AnalysisAgentKey,
        findingId: f.id,
        category: f.category as FindingCategory,
        severity: f.severity as FindingSeverity,
        title: f.title,
        body: f.body,
        tags: ev.tags,
        citations: ev.citations,
        verificationStatus: coerceVerificationStatus(f.verificationStatus),
        // Issue #773 — carry the gated verdict into synthesis so the per-requirement
        // roll-up (`computeVerdictsForRequirements`) reads a persisted value.
        verdict: ev.verdict,
        // Epic #1107 (#1110) — carry the panel's confidence into synthesis so
        // `orderFindingsForSynthesis` can RANK by it and the findings table can
        // mark it. Null on every flag-off run, which makes the ranking a no-op.
        supportPanel: ev.supportPanel,
      });
    }
  }
  return out;
}
