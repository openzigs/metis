/**
 * Typed wrappers around the Phase 7 analysis endpoints.
 */
import { apiFetch, streamFetch } from "@/lib/api-client";
import { filenameFromDisposition, parseStreamError } from "@/lib/plugins-api";
import type {
  AnalysisCapability,
  AnalysisCapabilityPreview,
  AnalysisAffectedCode,
  AnalysisDatabaseAware,
  AnalysisEscalation,
  AnalysisSkippedRepo,
  FindingSupportPanel,
  FindingVerificationStatus,
  RequirementCoverage,
  RequirementSupportConfidence,
  RequirementVerdict,
  SynthesisDegradation,
  TraceabilityMatrix,
  GapReport,
  RequirementDiff,
} from "@metis/shared";

export type {
  AnalysisCapability,
  AnalysisCapabilityPreview,
  RequirementCoverage,
} from "@metis/shared";
// Issue #740 (Epic #727) — per-finding verifier verdict.
export type { FindingVerificationStatus } from "@metis/shared";
// Issue #773 — three-state requirement verdict + the run's code-retrieval health.
export type { RequirementVerdict, AnalysisRetrievalHealth, SearchedQuery } from "@metis/shared";
export type {
  AnalysisAffectedCode,
  AffectedCodeCandidate,
  AffectedCodeSymbol,
} from "@metis/shared";
// Issue #739 (Epic #727) — per-requirement escalation depth decision.
export type { AnalysisEscalation, RequirementEscalation, AnalysisDepth } from "@metis/shared";
// Issue #859 (Epic #852 Phase 4b) — the database-aware-analysis resolver's
// ran/skipped decision for this run, surfaced on the analysis result view.
export type { AnalysisDatabaseAware, AnalysisDatabaseAwareReason } from "@metis/shared";
// Issue #737 (Epic #726) — requirement→findings→code→tests traceability matrix.
export type {
  TraceabilityMatrix,
  TraceabilityRow,
  TraceabilityCodeLocation,
  TraceabilityTestLink,
  TraceabilityFindingRef,
} from "@metis/shared";
// Issue #742 (Epic #728) — per-requirement gap report.
export type {
  GapReport,
  GapReportRequirement,
  GapReportCurrentImplementation,
  GapReportFindingRef,
} from "@metis/shared";
// Issue #825 / #827 (Epic #820) — the database twin of the gap findings:
// per-requirement affected tables/columns with suggested DDL, live-schema
// reconciliation, risk classification, and cross-project (shared-database)
// consumers.
export type {
  GapReportDatabaseChange,
  GapReportSchemaConsumer,
  GapReportRiskClass,
  GapReportConsumerUsage,
} from "@metis/shared";
// Issue #895 (Epic #882 Phase 3) — SQL-lineage unresolved/dynamic coverage.
export type { SqlLineageCoverage, SqlLineageUnresolvedRef } from "@metis/shared";
// Issue #743 (Epic #728) — diff-style current-vs-proposed view.
export type {
  RequirementDiff,
  RequirementDiffEntry,
  RequirementDiffCurrent,
  RequirementDiffProposed,
  RequirementDiffChangeType,
  RequirementDiffSeverity,
} from "@metis/shared";

export type AnalysisAgentKey = "document" | "code" | "database" | "web";
export type AnalysisAgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type AnalysisStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type RequirementReviewStatus = "draft" | "approved" | "rejected" | "deferred";

export interface AnalysisPersona {
  agentKey: AnalysisAgentKey | "synthesis";
  name: string;
  role: string;
  avatar: string;
  description: string;
}

/** Document evidence citation (historical shape). */
export interface AnalysisDocumentCitation {
  documentId: string;
  chunkIndex: number;
  filename?: string;
  snippet?: string;
  score?: number;
}

/**
 * Epic #726 (#734) — code evidence citation. A finding grounded in retrieved
 * source carries `filePath:startLine-endLine` (chat's #715 grounding format).
 */
export interface AnalysisCodeCitation {
  filePath: string;
  startLine: number;
  endLine: number;
  symbolId?: string;
  snippet?: string;
  score?: number;
}

export type AnalysisCitation = AnalysisDocumentCitation | AnalysisCodeCitation;

/** True when a citation points at source code (`filePath:startLine-endLine`). */
export function isCodeCitation(c: AnalysisCitation): c is AnalysisCodeCitation {
  return typeof (c as AnalysisCodeCitation).filePath === "string";
}

/** Render a code citation as its canonical `filePath:startLine-endLine` locator. */
export function formatCodeCitationLocator(c: AnalysisCodeCitation): string {
  return `${c.filePath}:${c.startLine}-${c.endLine}`;
}

export interface AnalysisFinding {
  id: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  tags: string[];
  citations: AnalysisCitation[];
  /** Epic #298 / #312 — provenance: 'extracted' | 'inferred' | 'ambiguous'. */
  derivation: "extracted" | "inferred" | "ambiguous";
  /** Epic #298 / #312 — confidence in [0, 1]. Always 1.0 when derivation='extracted'. */
  confidence: number;
  /** Epic #298 / #312 — id of the AgentResult that produced the finding. */
  agentResultId: string;
  /** Epic #912 (#916/#920) — id of the requirement this finding is grounded in, when known. */
  requirementId?: string | null;
  /**
   * Epic #727 (#740) — deterministic verifier verdict: `confirmed` (kept a
   * grounded code citation) | `unverified` (its code-evidence claim was dropped).
   * Null/absent for findings that made no code claim and for pre-#740 runs.
   */
  verificationStatus?: FindingVerificationStatus | null;
  /**
   * Issue #773 — the finding's gated three-state verdict. `could-not-verify` means
   * the claim is NOT backed by working retrieval and must never be rendered as a gap.
   */
  verdict?: RequirementVerdict | null;
  /**
   * Epic #1107 (#1109) — the multi-lens support panel's confidence signal.
   * Present only for runs made with `ANALYSIS_LLM_SUPPORT_PANEL` on. A GRADER,
   * not a gate: the panel never removes a finding, so this only ever affects
   * ranking and presentation. `confidence: "no-signal"` means the panel learned
   * NOTHING and must be rendered distinctly from `"low"` (#1110).
   */
  supportPanel?: FindingSupportPanel | null;
}

export interface AgentResultSummary {
  id: string;
  agentKey: AnalysisAgentKey | "synthesis";
  status: AnalysisAgentStatus;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  summary: string | null;
  findings: AnalysisFinding[];
}

export interface RequirementSummary {
  id: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  labels: string[];
  storyPoints: number | null;
  reviewStatus: RequirementReviewStatus;
  evidenceFindingIds: string[];
  /**
   * Epic #726 (#736) — deterministic coverage classification. Null (or absent)
   * for pre-#736 rows, in which case the badge renders a neutral state.
   */
  coverage?: RequirementCoverage | null;
  /**
   * Issue #773 — the three-state verdict: `implemented` | `gap-confirmed` |
   * `could-not-verify`. Null on doc-only runs and pre-#773 rows.
   */
  verdict?: RequirementVerdict | null;
  /**
   * Issue #1096 — the requirement's own testable acceptance criteria, derived at
   * synthesis. Empty (or absent, on pre-#1096 rows) means none were derived and
   * the UI says so explicitly rather than rendering placeholder criteria.
   */
  acceptanceCriteria?: string[];
  /**
   * Epic #34 (AC2) — optimistic-lock version of the requirement as rendered.
   * Submitted on edit/review-status saves so a stale form 409s against
   * concurrent writers (drives the MergeConflictModal).
   */
  version: number;
  /**
   * Epic #1107 (#1110) — the panel's confidence for this requirement, rolled up
   * from its evidence findings and carrying each dissenting lens's own reason
   * and `file:line`. Present on the analysis snapshot itself, so the UI answers
   * "why is this low-confidence?" with no second request. Null on every flag-off
   * and pre-#1109 run.
   */
  supportConfidence?: RequirementSupportConfidence | null;
}

export interface AnalysisListItem {
  id: string;
  projectId: string;
  startedById: string;
  status: AnalysisStatus;
  startedAt: string;
  completedAt: string | null;
  totalTokens: number;
  errorMessage: string | null;
}

/**
 * Issue #448 (epic #407) — server read-time resolution of an `evidenceId` (an
 * agent `Finding` row id) into a readable source ref. Optional fields are
 * absent when the id could not be resolved (legacy / deleted finding), in which
 * case the UI degrades to the raw `chunkId`.
 */
export interface ResolvedEvidenceRef {
  /** The raw evidence id — always preserved for the tooltip / copy. */
  chunkId: string;
  /** Readable source label (filename/path or documentId); absent when unresolved. */
  sourceLabel?: string;
  /** Originating documentId, when resolvable. */
  sourceId?: string;
  /** Citation position within the source, when available. */
  line?: number;
}

/** Epic #203 (#221) — a first-class cross-document detection finding. */
export interface CrossDocFindingSummary {
  id: string;
  kind:
    | "contradiction"
    | "missing-nfr"
    | "missing-acceptance-criteria"
    | "missing-assumption"
    | "missing-risk";
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
  evidenceIds: string[];
  /**
   * Issue #448 — server-resolved readable source refs for `evidenceIds`.
   * ADDITIVE / OPTIONAL: absent on legacy or un-enriched payloads, in which
   * case the UI renders the raw `evidenceIds`.
   */
  evidence?: ResolvedEvidenceRef[];
  scope: "self" | "pairwise" | null;
}

/** Epic #203 (#221) — bundle of cross-doc findings on the snapshot. */
export interface CrossDocFindingsSummary {
  findings: CrossDocFindingSummary[];
  contradictionCount: number;
  completenessGapCount: number;
  generatedAt: string;
}

export interface AnalysisSnapshot extends AnalysisListItem {
  inputTokens: number;
  outputTokens: number;
  metadata: Record<string, unknown> | null;
  agentResults: AgentResultSummary[];
  requirements: RequirementSummary[];
  /** Epic #203 (#221) — cross-doc findings; null when detection never ran. */
  crossDocFindings: CrossDocFindingsSummary | null;
  /** Issue #733 — degraded-mode capability record; null on pre-#733 runs. */
  capability: AnalysisCapability | null;
  /**
   * Issue #735 — deterministic requirement→code mapping for the "Evaluate new
   * requirements" free text; null when none was produced (pre-#735 / plain runs).
   */
  affectedCode: AnalysisAffectedCode | null;
  /**
   * Issue #739 — per-requirement escalation depth decision; null when the policy
   * was disabled (default) or the run had no agentic pass (pre-#739 / plain runs).
   */
  escalation: AnalysisEscalation | null;
  /**
   * Issue #855 (Epic #852) — the database-aware-analysis resolver's decision for
   * this run (whether schema reasoning ran, and why). Null when the resolver was
   * never applicable (no code/database agent ran) or on runs that predate #855.
   */
  databaseAware: AnalysisDatabaseAware | null;
}

type AnalysisSnapshotPayload = AnalysisListItem &
  Partial<{
    inputTokens: number;
    outputTokens: number;
    metadata: Record<string, unknown> | null;
    // The server snapshot serializes the agent runs under `agents` (see the
    // shared `AnalysisSnapshot` contract and the socket payloads). The agent
    // objects carry no top-level `id`, so it is synthesized from `agentKey`
    // (unique per analysis) when mapping into `AgentResultSummary`.
    agents: Array<Partial<AgentResultSummary> & Pick<AgentResultSummary, "agentKey">>;
    requirements: RequirementSummary[];
    crossDocFindings: CrossDocFindingsSummary | null;
    capability: AnalysisCapability | null;
    affectedCode: AnalysisAffectedCode | null;
    escalation: AnalysisEscalation | null;
    databaseAware: AnalysisDatabaseAware | null;
  }>;

export interface AnalysisCostCapStatus {
  monthlyCap: number;
  monthlyUsed: number;
  monthlyRemaining: number;
  monthBucket: string;
  exceeded: boolean;
}

export interface StartAnalysisInput {
  agentKeys?: AnalysisAgentKey[];
  documentIds?: string[];
  model?: string;
  /** Issue #907 — free-text new requirements for requirements→code gap evaluation (1..4096). */
  extraInstructions?: string;
  /** Epic #922 — opt-in web research on requirement items needing external evidence. */
  enableWebResearch?: boolean;
  /** Epic #922 — opt-in clarifying questions for ambiguous requirements. */
  enableClarification?: boolean;
}

export interface UpdateRequirementInput {
  title?: string;
  body?: string;
  priority?: string;
  type?: string;
  labels?: string[];
  storyPoints?: number | null;
  reviewStatus?: RequirementReviewStatus;
}

export const analysisApi = {
  listForProject: (projectId: string) =>
    apiFetch<{ items?: AnalysisListItem[] }>(`/projects/${projectId}/analyses`).then((res) => ({
      items: res.items ?? [],
    })),

  start: (projectId: string, body: StartAnalysisInput) =>
    apiFetch<{ id: string }>(`/projects/${projectId}/analyses`, {
      method: "POST",
      body,
    }),

  get: (id: string) =>
    apiFetch<AnalysisSnapshotPayload>(`/analyses/${id}`).then((snapshot) => ({
      ...snapshot,
      inputTokens: snapshot.inputTokens ?? 0,
      outputTokens: snapshot.outputTokens ?? 0,
      metadata: snapshot.metadata ?? null,
      agentResults: (snapshot.agents ?? []).map((agent) => ({
        ...agent,
        id: agent.id ?? agent.agentKey,
        status: agent.status ?? "pending",
        startedAt: agent.startedAt ?? null,
        completedAt: agent.completedAt ?? null,
        errorMessage: agent.errorMessage ?? null,
        summary: agent.summary ?? null,
        findings: agent.findings ?? [],
      })) as AgentResultSummary[],
      requirements: snapshot.requirements ?? [],
      crossDocFindings: snapshot.crossDocFindings ?? null,
      capability: snapshot.capability ?? null,
      affectedCode: snapshot.affectedCode ?? null,
      escalation: snapshot.escalation ?? null,
      databaseAware: snapshot.databaseAware ?? null,
    })),

  /**
   * Issue #733 — pre-run capability probe for the start-analysis form hint.
   * Returns the project-level facts (code graph / repo source / grounding flags)
   * so the form can warn which capabilities the run will have before starting.
   */
  capabilityPreview: (projectId: string) =>
    apiFetch<AnalysisCapabilityPreview>(`/projects/${projectId}/analyses/capability`),

  cancel: (id: string) =>
    apiFetch<{ cancelled: boolean }>(`/analyses/${id}/cancel`, { method: "POST" }),

  regenerateAgent: (id: string, agentKey: AnalysisAgentKey) =>
    apiFetch<{ accepted: boolean }>(`/analyses/${id}/agents/${agentKey}/regenerate`, {
      method: "POST",
    }),

  /**
   * Issue #741 (Epic #727) — re-run the agentic code agent for only the repos a
   * prior multi-repo run dropped for token budget. Returns `accepted: false`
   * when nothing was skipped (idempotent no-op). Progress streams over the
   * existing `analysis:{id}` Socket.IO room.
   */
  resumeRepos: (id: string) =>
    apiFetch<{
      accepted: boolean;
      resumed?: AnalysisSkippedRepo[];
      willResume?: AnalysisSkippedRepo[];
    }>(`/analyses/${id}/resume-repos`, { method: "POST" }),

  personas: () => apiFetch<{ items: AnalysisPersona[] }>(`/analyses/personas`),

  costCap: () => apiFetch<AnalysisCostCapStatus>(`/analyses/cost-cap`),

  // Epic #597 — Clarification dialog
  clarify: (projectId: string, analysisId: string, body: ClarifyInput) =>
    apiFetch<ClarificationStatePayload>(`/projects/${projectId}/analyses/${analysisId}/clarify`, {
      method: "POST",
      body,
    }),

  /**
   * Issue #1104 (finding C) — submitting answers returns a DIFFERENT shape from
   * starting a round: `{ state, updatedRequirements }`, not a bare state. The
   * submit path used to reuse `clarify()`'s state-shaped type and read
   * `result.completed` off it — always `undefined`, so the panel never
   * refreshed and the user's answers looked like they had been dropped.
   */
  submitClarifyAnswers: (
    projectId: string,
    analysisId: string,
    answers: Array<{ questionId: string; answer: string }>,
  ) =>
    apiFetch<ClarifySubmitResult>(`/projects/${projectId}/analyses/${analysisId}/clarify`, {
      method: "POST",
      body: { answers },
    }),

  // Epic #201 (#213) — rehydrate an in-flight clarification dialog after reload.
  getClarification: (projectId: string, analysisId: string) =>
    apiFetch<{ state: ClarificationStatePayload | null }>(
      `/projects/${projectId}/analyses/${analysisId}/clarify`,
    ),

  // Clarifying-question CSV round-trip (Business Analyst export/import).
  //
  // Export streams a raw text/csv attachment (NOT the `{ success, data }`
  // wrapper), so it goes through streamFetch + reads the blob for download.
  // Import posts multipart/form-data (FormData) — no JSON content-type — and
  // returns the parsed `{ applied, skipped, unmatched }` summary.
  async exportClarifyCsv(
    projectId: string,
    analysisId: string,
  ): Promise<{ blob: Blob; filename: string }> {
    const res = await streamFetch(`/projects/${projectId}/analyses/${analysisId}/clarify/export`, {
      method: "GET",
      headers: { Accept: "text/csv" },
      params: { format: "csv" },
    });
    if (!res.ok) {
      throw new Error(await parseStreamError(res));
    }
    const blob = await res.blob();
    const filename = filenameFromDisposition(
      res.headers.get("content-disposition"),
      `clarifying-questions-${analysisId}.csv`,
    );
    return { blob, filename };
  },

  // ── Issue #737 — traceability matrix (view + CSV/markdown export) ──────────

  /** Fetch the requirement→findings→code→tests matrix for an analysis. */
  getTraceability: (projectId: string, analysisId: string) =>
    apiFetch<TraceabilityMatrix>(`/projects/${projectId}/analyses/${analysisId}/traceability`),

  // ── Issue #742 — per-requirement gap report ───────────────────────────────

  /** Fetch the per-requirement gap report (current impl + gap + effort). */
  getGapReport: (projectId: string, analysisId: string) =>
    apiFetch<GapReport>(`/projects/${projectId}/analyses/${analysisId}/gap-report`),

  // ── Issue #743 — diff-style current-vs-proposed view ──────────────────────

  /**
   * Fetch the current-vs-proposed diff for the requirements that CHANGED between
   * a base run and this head run. `baseAnalysisId` defaults (server-side) to the
   * project's previous completed run; pass it to compare against a specific run.
   */
  getRequirementDiff: (projectId: string, analysisId: string, baseAnalysisId?: string) => {
    const suffix = baseAnalysisId ? `?base=${encodeURIComponent(baseAnalysisId)}` : "";
    return apiFetch<RequirementDiff>(
      `/projects/${projectId}/analyses/${analysisId}/requirement-diff${suffix}`,
    );
  },

  /**
   * Download the matrix as a server-serialized CSV or markdown attachment. The
   * export streams a raw text body (NOT the `{ success, data }` envelope), so it
   * goes through streamFetch + reads the blob for download — mirroring the
   * clarify CSV export.
   */
  async exportTraceability(
    projectId: string,
    analysisId: string,
    format: "csv" | "md",
  ): Promise<{ blob: Blob; filename: string }> {
    const res = await streamFetch(`/projects/${projectId}/analyses/${analysisId}/traceability`, {
      method: "GET",
      headers: { Accept: format === "csv" ? "text/csv" : "text/markdown" },
      params: { format },
    });
    if (!res.ok) {
      throw new Error(await parseStreamError(res));
    }
    const blob = await res.blob();
    const filename = filenameFromDisposition(
      res.headers.get("content-disposition"),
      `traceability-matrix-${analysisId}.${format}`,
    );
    return { blob, filename };
  },

  // ── Issue #744 — combined report + issue-draft export ─────────────────────

  /**
   * Download the combined analysis-report markdown (gap report + coverage +
   * traceability matrix, stitched server-side). Streams a raw markdown body — so
   * it goes through streamFetch + reads the blob, mirroring the #737 matrix
   * export.
   */
  async exportAnalysisReport(
    projectId: string,
    analysisId: string,
  ): Promise<{ blob: Blob; filename: string }> {
    const res = await streamFetch(`/projects/${projectId}/analyses/${analysisId}/export`, {
      method: "GET",
      headers: { Accept: "text/markdown" },
      params: { format: "md" },
    });
    if (!res.ok) {
      throw new Error(await parseStreamError(res));
    }
    const blob = await res.blob();
    const filename = filenameFromDisposition(
      res.headers.get("content-disposition"),
      `analysis-report-${analysisId}.md`,
    );
    return { blob, filename };
  },

  /**
   * Serialize a finding's (already-generated) deep-dive draft into a GitHub issue
   * draft. `format="md"` streams a paste-ready markdown attachment;
   * `format="issue"` returns the structured `{ title, body, labels }` for
   * copy-to-clipboard. The server does the (injection-safe) serialization so the
   * output is stable regardless of the caller's edits.
   */
  async exportFindingIssueDraftMarkdown(
    projectId: string,
    analysisId: string,
    findingId: string,
    draft: FindingIssueDraft,
  ): Promise<{ blob: Blob; filename: string }> {
    const res = await streamFetch(
      `/projects/${projectId}/analyses/${analysisId}/findings/${findingId}/export`,
      {
        method: "POST",
        headers: { Accept: "text/markdown", "Content-Type": "application/json" },
        params: { format: "md" },
        body: JSON.stringify(draft),
      },
    );
    if (!res.ok) {
      throw new Error(await parseStreamError(res));
    }
    const blob = await res.blob();
    const filename = filenameFromDisposition(
      res.headers.get("content-disposition"),
      `issue-draft-${findingId}.md`,
    );
    return { blob, filename };
  },

  exportFindingIssueDraft: (
    projectId: string,
    analysisId: string,
    findingId: string,
    draft: FindingIssueDraft,
  ) =>
    apiFetch<FindingIssueDraftExport>(
      `/projects/${projectId}/analyses/${analysisId}/findings/${findingId}/export?format=issue`,
      { method: "POST", body: draft },
    ),

  async importClarifyAnswers(
    projectId: string,
    analysisId: string,
    file: File,
  ): Promise<ClarifyImportResult> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await streamFetch(`/projects/${projectId}/analyses/${analysisId}/clarify/import`, {
      method: "POST",
      body: fd,
    });
    const json = (await res.json()) as
      | { success: true; data: ClarifyImportResult }
      | { success: false; error?: { message?: string } };
    if (!res.ok || json.success === false) {
      throw new Error(
        (json.success === false ? json.error?.message : undefined) ?? "Import failed",
      );
    }
    return json.data;
  },

  // Epic #597 — Approval checkpoints
  listApprovals: (projectId: string, analysisId: string) =>
    apiFetch<{ items: ApprovalRequestPayload[]; ticketStatus: TicketStatus }>(
      `/projects/${projectId}/analyses/${analysisId}/approvals`,
    ),

  reviewApproval: (
    projectId: string,
    analysisId: string,
    approvalId: string,
    body: { status: "approved" | "rejected"; reviewNote?: string },
  ) =>
    apiFetch<ApprovalRequestPayload>(
      `/projects/${projectId}/analyses/${analysisId}/approvals/${approvalId}`,
      { method: "PUT", body },
    ),

  // ── Epic #176 — Deep Dive → Issue ──────────────────────────────────────

  /** Sub 2: expand a single finding into an editable issue draft (1 LLM call). */
  deepDiveFinding: (
    projectId: string,
    analysisId: string,
    findingId: string,
    body: DeepDiveFindingInput = {},
  ) =>
    apiFetch<DeepDiveResult>(
      `/projects/${projectId}/analyses/${analysisId}/findings/${findingId}/deep-dive`,
      { method: "POST", body },
    ),

  /** Sub 3: publish an (edited) draft to the project's destination(s). */
  publishFinding: (
    projectId: string,
    analysisId: string,
    findingId: string,
    body: PublishFindingInput,
  ) =>
    apiFetch<{ links: PublishedIssueLink[] }>(
      `/projects/${projectId}/analyses/${analysisId}/findings/${findingId}/publish`,
      { method: "POST", body },
    ),
};

// ── Epic #176 — Deep Dive → Issue types ────────────────────────────────

export interface FindingIssueDraft {
  title: string;
  problemStatement: string;
  affected: { files: string[]; requirementIds: string[] };
  acceptanceCriteria: string[];
  suggestedLabels: string[];
}

export interface DeepDiveFindingInput {
  instructions?: string;
}

/** #744 — a finding's deep-dive draft serialized as a GitHub-ready issue draft. */
export interface FindingIssueDraftExport {
  title: string;
  body: string;
  labels: string[];
}

export interface DeepDiveResult {
  draft: FindingIssueDraft;
  meta: { tokensUsed: number; model: string };
}

export interface PublishFindingInput {
  provider?: "github" | "jira";
  draft: FindingIssueDraft;
  extraLabels?: string[];
}

export interface PublishedIssueLink {
  provider: string;
  url: string;
  issueKey: string;
}

// ── Epic #597 — Requirements Enhancement types ─────────────────────────

export interface ClarifyInput {
  requirements?: unknown;
  answers?: Array<{ questionId: string; answer: string }>;
}

/** Result of importing a filled clarifying-question CSV. */
export interface ClarifyImportResult {
  /** Count of answers matched + submitted via the existing submit path. */
  applied: number;
  /** Count of current-round questions left unanswered in the CSV. */
  skipped: number;
  /** questionIds in the CSV that don't match the current round. */
  unmatched: string[];
}

export interface GroundingCitation {
  source: string;
  snippet: string;
  documentId?: string;
  chunkId?: string;
  score?: number;
}

export interface ClarifyingQuestion {
  id: string;
  requirementId: string;
  ambiguityField: string;
  question: string;
  context: string;
  /**
   * Self-resolution status from the server's retrieval-grounded pass. Absent is
   * treated as "open" (a plain blank question).
   */
  groundingStatus?: "grounded" | "partial" | "open";
  /** Suggested answer text to pre-fill (grounded/partial only). */
  groundedAnswer?: string;
  /** Supporting citations for the suggested answer. */
  groundingCitations?: GroundingCitation[];
  /**
   * Issue #1104 (finding C) — the answer the user submitted for this question,
   * stamped onto the persisted round by the server. Present only on rounds that
   * have been answered.
   */
  answer?: string;
}

export interface ClarificationRound {
  round: number;
  questions: ClarifyingQuestion[];
  answers: Array<{ questionId: string; answer: string }>;
}

export interface ClarificationStatePayload {
  analysisId: string;
  currentRound: number;
  maxRounds: number;
  rounds: ClarificationRound[];
  /** What the resolution MODEL confirmed it could close. Often far fewer than
   *  the questions the user answered — see `answeredAmbiguities`. */
  resolvedAmbiguities: string[];
  /**
   * Issue #1117 (finding A) — what the USER answered, computed deterministically
   * server-side. Absent on dialogs persisted before #1117.
   */
  answeredAmbiguities?: string[];
  escalatedToSonnet: boolean;
  completed: boolean;
}

/** Issue #1104 — response shape of the answers branch of `POST .../clarify`. */
export interface ClarifySubmitResult {
  state: ClarificationStatePayload;
  updatedRequirements: StructuredRequirementsPayload;
}

// ── Epic #922 — Enhancement metadata (web research + structured reqs) ─────────

export type DomainTrust = "high" | "medium" | "low";

export interface WebSource {
  url: string;
  title: string;
  excerpt: string;
  relevanceScore: number;
  domainTrust: DomainTrust;
}

export interface EvidenceDigest {
  id: string;
  requirementId: string;
  evidenceNeedId: string;
  query: string;
  sources: WebSource[];
  digest: string;
  needsHumanReview: boolean;
}

export interface WebResearchResultPayload {
  digests: EvidenceDigest[];
  totalSources: number;
  reviewRequired: number;
}

/** Epic #597 / #622 — a single ambiguity flagged on a structured requirement. */
export interface RequirementAmbiguity {
  field: string;
  description: string;
  suggestedQuestion: string;
}

/** Epic #597 / #622 — a claim on a structured requirement that needs evidence. */
export interface RequirementEvidenceNeed {
  id?: string;
  description: string;
  domain?: string;
  searchHints?: string[];
}

export interface StructuredRequirement {
  id: string;
  title: string;
  description: string;
  ambiguities: RequirementAmbiguity[];
  evidenceNeeds: RequirementEvidenceNeed[];
}

export interface StructuredRequirementsPayload {
  requirements: StructuredRequirement[];
  totalAmbiguities: number;
  totalEvidenceNeeds: number;
}

/**
 * Shape of the enhancement data the orchestrator persists into analysis
 * `metadata` (Epic #922). All keys are optional — present only when the
 * matching opt-in flag ran.
 */
export interface EnhancementMetadata {
  enhancement?: { enableWebResearch: boolean; enableClarification: boolean };
  structuredRequirements?: StructuredRequirementsPayload;
  webResearch?: WebResearchResultPayload;
  /**
   * Epic #202 (#216) / Issue #1104 — the approval gate's durable state. When
   * `blocked` is true the run DID synthesize requirements
   * (`awaitingRequirementCount`) and they are withheld, not missing.
   */
  promotionBlocked?: {
    blocked: boolean;
    pendingCount: number;
    rejectedCount: number;
    awaitingRequirementCount?: number;
    reason?: string;
  };
  promotionStatus?: "allowed" | "blocked";
  /**
   * Issue #1116 — what the last clarification pass did with the user's answers.
   * Written by the server's enrichment pass; drives the note that tells the user
   * which answers reach a published issue and which only shape this screen.
   */
  clarificationApplication?: {
    answeredCount: number;
    appliedCount: number;
    unattributedCount: number;
    requirementsUpdated: number;
    requirementsAvailable: boolean;
    updatedAt: string;
  };
  /**
   * Issue #1117 (findings B + C) — present only when synthesis fell back to the
   * deterministic clusterer, which is why every requirement in such a run is
   * typed "feature" and carries no acceptance criteria.
   */
  synthesisDegraded?: SynthesisDegradation;
}

/** Narrow a snapshot's untyped `metadata` blob into the enhancement view. */
export function readEnhancementMetadata(
  metadata: Record<string, unknown> | null | undefined,
): EnhancementMetadata {
  if (!metadata || typeof metadata !== "object") return {};
  return metadata as EnhancementMetadata;
}

export interface ApprovalRequestPayload {
  id: string;
  analysisId: string;
  type: string;
  itemId: string;
  status: string;
  reviewerId: string | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface TicketStatus {
  allowed: boolean;
  pendingCount: number;
  rejectedCount: number;
}
