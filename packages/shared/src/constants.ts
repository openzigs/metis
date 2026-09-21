/**
 * Cross-cutting constants used by both server and UI.
 * These are the source of truth — no string literals in feature code.
 */

// ---- Role keys (must match seed data) --------------------------------------
export const ROLE_KEYS = ["admin", "coordinator", "developer", "reader"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

// ---- Permission keys -------------------------------------------------------
export const PERMISSION_KEYS = [
  "project.create",
  "project.read",
  "project.update",
  "project.delete",
  "document.upload",
  "document.read",
  "document.delete",
  "analysis.run",
  "analysis.read",
  "issue.draft",
  "issue.preview",
  "issue.publish",
  "vault.read",
  "vault.write",
  "mcp.manage",
  // Epic #162 — finer-grained MCP permissions for the v1.1.0 platform UI.
  "mcp.read",
  "mcp.write",
  "skill.manage",
  "agent.manage",
  "user.manage",
  "role.manage",
  "audit.read",
  "connector.read",
  "connector.write",
  "connector.test",
  "connector.query",
  "scheduler.read",
  "scheduler.manage",
  "task.read",
  "task.cancel",
  "task.retry",
  // Phase 12 — admin-only read of redacted runtime configuration (env vars view).
  "admin.read",
  // Epic #164 — admin-only write of FinOps + safety project settings (budget caps, etc).
  "admin.write",
  // Epic #394 (#400) — PR-reviewer agent permissions.
  "pr.review",
  "pr.review.read",
  "pr.review.manage",
  // Epic #396 — Spec Kit-compatible workflow (MVP-2): constitution writes
  // are RBAC-gated independently of `project.update` because the constitution
  // is "supreme law" for every other Spec Kit phase.
  "speckit.constitution.write",
  // Epic #739 — Bidirectional Issue Sync permissions.
  "sync.read",
  "sync.resolve",
  // Epic #609 (#617) — formal review & approval workflow for requirements
  // and specs. `review.admin` allows withdrawing/closing reviews requested
  // by other users (the requester can always manage their own).
  "review.create",
  "review.read",
  "review.decide",
  "review.admin",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

// ---- Lifecycle status enums ------------------------------------------------
export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PROJECT_STATUSES = ["draft", "active", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * v1.0.1 issue #134 — provider keys exposed to the UI for the per-project
 * AI provider override dropdown. Server-side validation in
 * `project-service.ts` re-checks this list via `SUPPORTED_PROVIDER_KEYS`.
 */
export const AI_PROVIDER_KEYS = [
  "copilot-native",
  "bedrock-gateway",
  "local-gemma",
  "openai",
  "azure",
  "anthropic",
  "offline-stub",
] as const;
export type AIProviderKey = (typeof AI_PROVIDER_KEYS)[number];

export const ANALYSIS_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const AGENT_RESULT_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AgentResultStatus = (typeof AGENT_RESULT_STATUSES)[number];

// ---- Multi-agent analysis (Phase 7) ----------------------------------------
/**
 * Stable agent identifiers persisted on `AgentResult.agentKey`. Order is
 * meaningful — the parallel pipeline phase iterates this list directly.
 */
export const ANALYSIS_SPECIALIST_AGENT_KEYS = ["document", "code", "database", "web"] as const;
export type AnalysisSpecialistAgentKey = (typeof ANALYSIS_SPECIALIST_AGENT_KEYS)[number];

/** Includes the synthesis/reviewer agent that runs after the specialists. */
export const ANALYSIS_AGENT_KEYS = [...ANALYSIS_SPECIALIST_AGENT_KEYS, "synthesis"] as const;
export type AnalysisAgentKey = (typeof ANALYSIS_AGENT_KEYS)[number];

export const REQUIREMENT_REVIEW_STATUSES = ["draft", "approved", "rejected", "deferred"] as const;
export type RequirementReviewStatus = (typeof REQUIREMENT_REVIEW_STATUSES)[number];

/**
 * Epic #726 (#736) — per-requirement coverage classification, computed
 * deterministically at synthesis time from the requirement's linked-finding
 * evidence (NOT by an LLM):
 *   - `grounded_in_code`      — at least one linked finding carries a validated
 *                               CODE citation (`filePath:startLine-endLine`,
 *                               #734). Deterministic #735 affected-code mappings
 *                               fold in here transitively: a mapped file the code
 *                               agent cites survives citation-grounding as a code
 *                               citation.
 *   - `grounded_in_docs_only` — the requirement has linked-finding citations, but
 *                               every one is a DOCUMENT citation.
 *   - `no_evidence`           — no linked findings, or the only linkage is a
 *                               placeholder / citation-free finding.
 * Null on rows written before #736 (the UI renders the null state gracefully).
 */
export const REQUIREMENT_COVERAGES = [
  "grounded_in_code",
  "grounded_in_docs_only",
  "no_evidence",
] as const;
export type RequirementCoverage = (typeof REQUIREMENT_COVERAGES)[number];

/**
 * Issue #773 — the per-requirement VERDICT. Coverage (above) answers "what KIND
 * of evidence is this requirement linked to?"; the verdict answers the question
 * the BA actually asks: "do we have to BUILD this?".
 *
 * The distinction is load-bearing and was the #773 incident: `grounded_in_code`
 * means "some code was cited", NOT "the requirement is implemented", and
 * `no_evidence` was read by every downstream surface as "confirmed gap" when its
 * real cause was that the agent's searches failed.
 *
 *   - `implemented`      — the agent retrieved code that satisfies the
 *                          requirement, and cited it (the citation survived the
 *                          #734 provenance gate).
 *   - `gap-confirmed`    — the agent's retrieval WORKED (see the evidence
 *                          threshold in `analysis/retrieval-health.ts`) and the
 *                          code it inspected does not satisfy the requirement.
 *                          This is the only state that licenses "go build it".
 *   - `could-not-verify` — we do not know. Retrieval failed, returned nothing
 *                          usable, or the investigation never reached this
 *                          requirement (turn/token budget). ABSENCE OF EVIDENCE
 *                          IS NOT EVIDENCE OF ABSENCE — this state must NEVER be
 *                          presented as a gap.
 *
 * `null` = no verdict (the code agent did not participate in the run, or the row
 * predates #773). The UI renders null as a neutral, badge-free state.
 */
export const REQUIREMENT_VERDICTS = ["implemented", "gap-confirmed", "could-not-verify"] as const;
export type RequirementVerdict = (typeof REQUIREMENT_VERDICTS)[number];

/**
 * Epic #727 (#740) — per-FINDING verification status set by the deterministic
 * verifier/critic pass that runs BETWEEN agent completion and synthesis. This is
 * distinct from {@link REQUIREMENT_COVERAGES} (a per-REQUIREMENT label computed
 * AT synthesis): verification adversarially checks each finding's CODE-evidence
 * claim against the #734 grounding gate BEFORE the finding can flow into
 * synthesis.
 *
 *   - `confirmed`  — the finding retained at least one CODE citation that
 *                    survived the #734 provenance gate (its claimed
 *                    `filePath:startLine-endLine` was actually in the retrieved
 *                    corpus). Its code-evidence claim is supported.
 *   - `unverified` — the finding asserted CODE evidence (≥1 code / `code-graph:`
 *                    citation) but EVERY such citation was DROPPED by the #734
 *                    gate as un-retrievable / hallucinated, leaving no surviving
 *                    code citation. The claim could not be confirmed against the
 *                    code — it is demoted (down-weighted in synthesis), never
 *                    silently dropped.
 *   - `could-not-verify` — Issue #773. The finding asserts an ABSENCE ("no
 *                    evidence found for X", "X is not implemented") but carries
 *                    NO code citation, and the run's retrieval could not back an
 *                    absence claim (tool calls errored / returned nothing, or the
 *                    investigation was cut short by the turn/token budget). Before
 *                    #773 such a finding classified `null` — an absence claim
 *                    cites nothing, so it had nothing to ground and sailed
 *                    through this gate unflagged, then flowed into the gap report
 *                    as a CONFIRMED gap. It is now labelled for what it is: an
 *                    unsupported claim about what the code does NOT contain.
 *
 * `null` (the fourth, un-enumerated state) means "no code-evidence claim to
 * verify" — a doc-only or generic specialist finding that never cited code, plus
 * every finding written before #740. The UI renders `null` as a neutral, badge-
 * free state. Only findings on the code-grounding paths receive a non-null value.
 */
export const FINDING_VERIFICATION_STATUSES = [
  "confirmed",
  "unverified",
  "could-not-verify",
] as const;
export type FindingVerificationStatus = (typeof FINDING_VERIFICATION_STATUSES)[number];

/**
 * Epic #1107 (#1109) — the lenses of the multi-lens support panel.
 *
 * Each lens is a SEPARATE, INDEPENDENT model call that judges the SAME
 * proposition — *"is this finding's claim supported by the evidence the run
 * actually retrieved?"* — but is told to interrogate it from one angle only. No
 * lens sees another's verdict and none is asked to predict consensus: a panel of
 * three agreeable voters is worth nothing.
 *
 *   - `support`  — does the cited evidence actually BACK the claim, or merely
 *                  exist? This is the judgement the deterministic #740 gate
 *                  structurally cannot make (it can only ask "was this file
 *                  retrieved?"), and the reason #1109 exists.
 *   - `scope`    — is the claim's BREADTH justified by the evidence, or is one
 *                  example generalised into "the system does X"?
 *   - `currency` — is the evidence CURRENT, or contradicted elsewhere in the
 *                  retrieved set (a stale comment, a superseded branch, a second
 *                  excerpt that says the opposite)?
 */
export const SUPPORT_PANEL_LENSES = ["support", "scope", "currency"] as const;
export type SupportPanelLens = (typeof SUPPORT_PANEL_LENSES)[number];

/**
 * Epic #1107 (#1109) — one lens's judgement of the finding.
 *
 * There is deliberately NO "false positive" value. METIS is recall-first and the
 * panel is a GRADER, not a gate: no vote combination may delete a finding, so a
 * vote's strongest possible effect is to lower the finding's confidence label.
 */
export const SUPPORT_PANEL_JUDGEMENTS = ["supported", "unsupported", "uncertain"] as const;
export type SupportPanelJudgement = (typeof SUPPORT_PANEL_JUDGEMENTS)[number];

/**
 * Epic #1107 (#1109) — why a lens's vote was NOT counted in the tally.
 *
 *   - `no-signal`        — the lens produced no parseable, schema-valid verdict
 *                          even after #1114's single re-prompt, OR the provider
 *                          call failed. **This is the absence of evidence, never
 *                          evidence of absence** — it must never be presented or
 *                          tallied as a vote against the finding.
 *   - `missing-citation` — the lens returned a verdict but no decisive
 *                          `file:line` locator drawn from the evidence it was
 *                          given. #1109 requires every counted verdict to cite
 *                          one; that is what makes the signal auditable rather
 *                          than a vibe.
 */
export const SUPPORT_PANEL_DISCARD_REASONS = ["no-signal", "missing-citation"] as const;
export type SupportPanelDiscardReason = (typeof SUPPORT_PANEL_DISCARD_REASONS)[number];

/**
 * Epic #1107 (#1109) — the panel's AGGREGATE confidence in a finding, computed
 * in code by a pure tally (`aggregatePanelVotes`), never by a model.
 *
 *   - `high`      — every counted lens found the claim supported.
 *   - `medium`    — real dissent that did not carry (at least one `unsupported`
 *                   vote outnumbered by `supported` ones), or nobody dissented
 *                   but at least one lens was `uncertain`.
 *   - `low`       — the not-supported voices OUTWEIGH the supporting ones. The
 *                   finding is still delivered in full; it is down-weighted for
 *                   reviewer attention, never dropped.
 *   - `no-signal` — not one lens produced a countable verdict. Distinct from
 *                   `low` BY CONSTRUCTION and must be rendered distinctly: the
 *                   panel learned nothing about this finding, which is not the
 *                   same as learning that it is weak.
 *
 * CAVEAT THAT TRAVELS WITH THIS LABEL: the panel reads only the evidence the
 * agent itself retrieved. `high` therefore means "supported by what we
 * retrieved", NOT "true". If retrieval missed something, the panel cannot know.
 */
export const SUPPORT_PANEL_CONFIDENCES = ["high", "medium", "low", "no-signal"] as const;
export type SupportPanelConfidence = (typeof SUPPORT_PANEL_CONFIDENCES)[number];

/**
 * Epic #1107 (#1111 / A3) — the verdict on an ABSENCE claim, i.e. a finding that
 * asserts the codebase does NOT contain something ("X is not implemented", "No
 * evidence found for X").
 *
 * #773 named the structural hole this closes: an absence claim CITES NOTHING, so
 * a citation-counter drops nothing, retains nothing, and classifies `null` — it
 * sails through every deterministic gate unflagged and is rendered downstream as
 * a confirmed gap. A verifier that READS the retrieved evidence can answer the
 * question counting cannot.
 *
 *   - `supported`    — the retrieved evidence covers where the thing would be,
 *                      and it is genuinely not there. "We looked and found
 *                      nothing."
 *   - `contradicted` — evidence of the thing WAS retrieved; the claim is wrong.
 *                      The single most expensive error this product makes is
 *                      telling someone to build what they already have.
 *   - `unexamined`   — the evidence needed to judge was never retrieved. "We
 *                      never looked."
 *
 * **`unexamined` MUST NOT present as `supported`.** That conflation is the whole
 * point of #1111: today the two produce identical text, and a clean report that
 * merges "scanned and clean" with "not scanned" is worse than no report.
 *
 * There is a FOURTH state, deliberately kept out of this union: the verifier
 * itself returning no parseable verdict (#1114's `no-signal`). That is a fact
 * about the VERIFIER, whereas all three values above are facts about the
 * EVIDENCE. It is modelled as a `null` verdict, never as a fourth member here,
 * so the two can never be collapsed by a consumer reading the enum.
 */
export const ABSENCE_CLAIM_VERDICTS = ["supported", "contradicted", "unexamined"] as const;
export type AbsenceClaimVerdict = (typeof ABSENCE_CLAIM_VERDICTS)[number];

/**
 * Default monthly token cap for analysis runs (env-tunable via
 * `ANALYSIS_MONTHLY_TOKEN_CAP`). Set to 0 to disable enforcement.
 */
export const DEFAULT_ANALYSIS_MONTHLY_TOKEN_CAP = 5_000_000;

/** Default per-agent token cap (env-tunable via `ANALYSIS_AGENT_TOKEN_CAP`). */
export const DEFAULT_ANALYSIS_AGENT_TOKEN_CAP = 80_000;

/** Default ceiling on findings/agent before truncation (env: `ANALYSIS_MAX_FINDINGS_PER_AGENT`). */
export const DEFAULT_MAX_FINDINGS_PER_AGENT = 25;

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CATEGORIES = [
  "security",
  "performance",
  "architecture",
  "dependency",
  "reliability",
  "compliance",
  "other",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

// ---- Cross-document detection (Epic #203) ----------------------------------
/**
 * NLI labels for statement-pair classification (Issue #219).
 * `contradiction` is the only label persisted as a finding; `entailment` and
 * `neutral` pairs are discarded by the detector.
 */
export const NLI_LABELS = ["entailment", "neutral", "contradiction"] as const;
export type NliLabel = (typeof NLI_LABELS)[number];

/**
 * Categories of cross-document detection finding (Epic #203). A
 * `contradiction` originates from the NLI detector (#219); the remaining
 * categories originate from the completeness checklist (#220).
 */
export const CROSS_DOC_FINDING_KINDS = [
  "contradiction",
  "missing-nfr",
  "missing-acceptance-criteria",
  "missing-assumption",
  "missing-risk",
] as const;
export type CrossDocFindingKind = (typeof CROSS_DOC_FINDING_KINDS)[number];

/** Scope of a contradiction — within one document or across documents (#219). */
export const CONTRADICTION_SCOPES = ["self", "pairwise"] as const;
export type ContradictionScope = (typeof CONTRADICTION_SCOPES)[number];

export const REQUIREMENT_TYPES = ["feature", "bug", "chore", "epic", "task"] as const;
export type RequirementType = (typeof REQUIREMENT_TYPES)[number];

export const REQUIREMENT_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];

export const ISSUE_DRAFT_STATUSES = [
  "draft",
  "approved",
  "publishing",
  "published",
  "failed",
] as const;
export type IssueDraftStatus = (typeof ISSUE_DRAFT_STATUSES)[number];

export const PUBLISH_BATCH_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type PublishBatchStatus = (typeof PUBLISH_BATCH_STATUSES)[number];

export const PUBLISHED_ISSUE_STATUSES = ["created", "updated", "failed"] as const;
export type PublishedIssueStatus = (typeof PUBLISHED_ISSUE_STATUSES)[number];

// ---- Epic #557 — Change Analysis + Dual-Destination Publishing -------------
export const CHANGE_ANALYSIS_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type ChangeAnalysisStatus = (typeof CHANGE_ANALYSIS_STATUSES)[number];

export const CHANGE_TYPES = ["added", "removed", "modified"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const CHANGE_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type ChangeSeverity = (typeof CHANGE_SEVERITIES)[number];

export const CHANGE_REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type ChangeReviewStatus = (typeof CHANGE_REVIEW_STATUSES)[number];

export const PUBLISH_DESTINATIONS = ["github", "jira", "both"] as const;
export type PublishDestination = (typeof PUBLISH_DESTINATIONS)[number];

export const MCP_SCOPES = ["global", "project", "user"] as const;
export type MCPScope = (typeof MCP_SCOPES)[number];

export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export type MCPTransport = (typeof MCP_TRANSPORTS)[number];

/**
 * Epic #271 — execution runtime for an MCP server. Decoupled from
 * `transport` (which describes the wire format). `k8s-sse` is reserved for
 * Phase B (#272); the admin UI surfaces it as a disabled option today.
 */
export const MCP_RUNTIMES = ["native", "docker-stdio", "k8s-sse"] as const;
export type MCPRuntime = (typeof MCP_RUNTIMES)[number];
export const DEFAULT_MCP_RUNTIME: MCPRuntime = "native";

export const MCP_STATUSES = ["idle", "starting", "ready", "error", "disabled"] as const;
export type MCPStatus = (typeof MCP_STATUSES)[number];

export const MCP_TRUST_LEVELS = ["trusted", "untrusted"] as const;
export type MCPTrustLevel = (typeof MCP_TRUST_LEVELS)[number];

export const MCP_TOOL_RISKS = ["low", "medium", "high"] as const;
export type MCPToolRisk = (typeof MCP_TOOL_RISKS)[number];

export const REPO_PROVIDERS = [
  "github",
  "github_enterprise",
  "gitlab",
  // Issue #288 — non-source-controlled code ingestion:
  //   "local"  → a filesystem directory the METIS server can read (allowlisted)
  //   "upload" → a user-uploaded .zip archive of a directory
  "local",
  "upload",
] as const;
export type RepoProvider = (typeof REPO_PROVIDERS)[number];

/** Providers whose ingest source is a filesystem path / archive, not a clone. */
export const NON_GIT_REPO_PROVIDERS = ["local", "upload"] as const;

export const DB_DRIVERS = ["postgres", "mysql", "oracle", "sqlserver", "sqlite", "jdbc"] as const;
export type DbDriver = (typeof DB_DRIVERS)[number];

export const TASK_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const DOCUMENT_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * MIME types accepted by the upload pipeline. PDF/DOCX/XLSX entries reflect
 * the AC for #39 — actual parsing of the binary formats is gated on the
 * optional `pdf-parse`/`mammoth` libs being available; when missing the
 * uploads are still accepted but the document is left in `pending` state.
 */
export const UPLOAD_MIME_ALLOWLIST = [
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/html",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;
export type UploadMimeType = (typeof UPLOAD_MIME_ALLOWLIST)[number];

/**
 * Filename extensions accepted as a fallback when the browser supplies a
 * generic `application/octet-stream` content-type.
 */
export const UPLOAD_EXTENSION_ALLOWLIST = [
  "txt",
  "md",
  "markdown",
  "html",
  "htm",
  "json",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
] as const;

// ---- Default limits --------------------------------------------------------
/** Maximum upload size for a single document (10 MB). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Maximum rows returned by an ad-hoc database query. */
export const MAX_QUERY_ROWS = 100;

/** Default page size for paginated list endpoints. */
export const DEFAULT_PAGE_SIZE = 25;

/** Hard cap on page size. */
export const MAX_PAGE_SIZE = 100;

/** Maximum number of issues that can be queued in a single PublishBatch. */
export const MAX_BATCH_ISSUES = 250;

// ---- Publishing (Phase 9) --------------------------------------------------
/** Inter-mutation delay between GitHub publish writes (R-F2). */
export const DEFAULT_PUBLISH_RATE_LIMIT_DELAY_MS = 1000;
/** Symmetric jitter applied to the inter-mutation delay. */
export const DEFAULT_PUBLISH_RATE_LIMIT_JITTER_MS = 200;
/** Base delay for secondary-rate-limit exponential backoff. */
export const DEFAULT_PUBLISH_SECONDARY_BACKOFF_BASE_MS = 60_000;
/** Cap for secondary-rate-limit exponential backoff (10 min). */
export const DEFAULT_PUBLISH_SECONDARY_BACKOFF_MAX_MS = 600_000;
/** Hard cap on per-call retry attempts. */
export const DEFAULT_PUBLISH_MAX_RETRIES = 3;
/** Hard cap on the total time the publisher will spend in backoff per batch. */
export const DEFAULT_PUBLISH_BACKOFF_BUDGET_MS = 30 * 60_000;
/** Default api.github.com base URL when no GHE override is set. */
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
/** REST API version sent on every Octokit call (#69 AC). */
export const GITHUB_API_VERSION = "2026-03-10";
/** Marker comment prefix used for idempotent dedup recovery. */
export const PUBLISH_MARKER_PREFIX = "<!-- metis-publish:";

/** Maximum task retry attempts. */
export const DEFAULT_MAX_TASK_ATTEMPTS = 3;

/** Default task priority (1=highest, 10=lowest). */
export const DEFAULT_TASK_PRIORITY = 5;

// ---- RAG defaults ----------------------------------------------------------
/** Default chunk size in characters (~512 tokens at 4 chars/token). */
export const DEFAULT_RAG_CHUNK_SIZE = 2048;

/** Default chunk overlap in characters (~64 tokens). */
export const DEFAULT_RAG_CHUNK_OVERLAP = 256;

/** Default embedding model id used by the offline/stub backend. */
export const DEFAULT_EMBED_MODEL = "metis-offline-hash-v1";

/**
 * Vector dimension of the offline hash stub (`metis-offline-hash-v1`).
 *
 * PINNED, and deliberately NOT the same constant as {@link DEFAULT_EMBED_DIMENSION}
 * (issue #783). Vectors are model-TAGGED: every row that says
 * `metis-offline-hash-v1` must be the same width, or a single model id spans two
 * incompatible vector spaces and every comparison between them is meaningless.
 * The hash stub's width therefore stays at 384 forever, independent of whatever
 * dimension the *real* default model happens to have.
 */
export const OFFLINE_EMBED_DIMENSION = 384;

/**
 * Default embedding model used by the in-process / sidecar transformers.js
 * backend.
 *
 * `Alibaba-NLP/gte-modernbert-base` — 768-dim, **CLS-pooled**, `q8` weights.
 * Flipped from `Xenova/bge-small-en-v1.5` (384d, mean) by epic #780 / issue #783
 * on the strength of the #788 before/after retrieval eval: on NL-requirement →
 * code retrieval it scores **0.402 nDCG@10 vs bge-small's 0.246** (+0.156, 95% CI
 * [+0.054, +0.266], sign test p = 0.007).
 *
 * THE POOLING IS PART OF THE MODEL CHOICE, NOT A TUNABLE. The same model at
 * `mean` pooling scored 0.254 — level with the model it replaces, and identical
 * to it in the hybrid channel (0.287 vs 0.287), i.e. an upgrade that buys nothing
 * and that NO end-to-end metric would flag. `cls` is bound to this id by the
 * per-model map in `server/src/lib/rag/embed-model-config.ts`; do not "simplify"
 * that map away.
 *
 * The dtype is `q8` (see `DEFAULT_DTYPE`): q8 scored HIGHER than fp32 (0.402 vs
 * 0.360) and it is what both Dockerfiles bake — an air-gapped image asking for
 * fp32 would look for weights that were never baked and die at boot.
 */
export const DEFAULT_XENOVA_EMBED_MODEL = "Alibaba-NLP/gte-modernbert-base";

/**
 * Default embedding vector dimension — the width of
 * {@link DEFAULT_XENOVA_EMBED_MODEL}'s output (768 for gte-modernbert-base).
 *
 * Changing this is an INDEX-CONTRACT change: it sizes the pgvector column and the
 * Lance table schema. Chunks already embedded at the old width are excluded from
 * retrieval by their `embeddingModel` tag (they are not silently compared against
 * new-width vectors), but they stay unusable until a reindex (#787).
 */
export const DEFAULT_EMBED_DIMENSION = 768;

/** Default top-k for knowledge retrieval. */
export const DEFAULT_RETRIEVE_K = 5;

/** Hard cap on top-k for knowledge retrieval. */
export const MAX_RETRIEVE_K = 50;

/**
 * Analysis-pipeline retrieval top-k (Epic #912 / #918). Wider than the global
 * chat default so grounded evidence isn't truncated before fusion + rerank.
 * Retrieve wide, then the reranker (#919) trims to a precise top-k.
 */
export const ANALYSIS_RETRIEVE_K = 10;

/**
 * Candidate pool size fed into RRF + cross-encoder rerank on the analysis path
 * (Epic #912 / #918, #919). Deliberately larger than `max(k*4, 20)` so the
 * reranker has enough material to reorder against the "lost in the middle"
 * problem.
 */
export const ANALYSIS_FUSION_POOL_SIZE = 40;

/**
 * Hard cap on the number of distinct retrieval queries fused per analysis
 * retrieval call (Epic #912 / #917). Bounds latency and token/embedding cost
 * when combining the static bag, derived query, extraInstructions, and
 * per-requirement queries.
 */
export const MAX_ANALYSIS_RETRIEVAL_QUERIES = 6;

/**
 * Hard cap on the number of extracted requirements that drive per-requirement
 * retrieval (Epic #912 / #916). Bounds the fan-out of the grounding loop.
 */
export const MAX_REQUIREMENTS_FOR_RETRIEVAL = 24;

/**
 * Concurrency cap for the per-requirement retrieval loop (Epic #912 / #916).
 * Keeps the embedding/search round-trips bounded so a large requirement set
 * cannot saturate the knowledge service.
 */
export const REQUIREMENT_RETRIEVAL_CONCURRENCY = 4;

/** Hard cap on bytes a document parser will accept (25 MB). */
export const MAX_DOCUMENT_PARSE_BYTES = 25 * 1024 * 1024;

/** Hard cap on PDF page count to prevent runaway memory use. */
export const MAX_PDF_PAGES = 2000;

/** ANN-index threshold: switch from brute-force to indexed scan above this many vectors. */
export const VECTOR_ANN_THRESHOLD = 1000;

// ---- Connectors (Phase 8) --------------------------------------------------
/** Lifecycle status for a Repo or Database connector row. */
export const CONNECTOR_STATUSES = ["pending", "connected", "error", "disabled"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/** Hard ceiling on rows returned by the query-database tool. */
export const QUERY_DB_MAX_ROWS = 100;

/** Default statement timeout for connector-issued SQL (ms). */
export const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Timeout for schema introspection (ms). Deliberately far larger than
 * {@link DEFAULT_DB_STATEMENT_TIMEOUT_MS}: introspection reads the data
 * dictionary, and on an enterprise Oracle instance a single `COUNT(*)` over
 * `ALL_TAB_COLUMNS` has been measured at ~7s, so the full column/PK/FK join
 * across a several-hundred-table schema comfortably exceeds a 10s budget.
 * Interactive user queries keep the shorter timeout.
 */
export const DEFAULT_DB_INTROSPECT_TIMEOUT_MS = 120_000;

/** Default per-connection pool max size. */
export const DEFAULT_DB_POOL_MAX = 5;

/** Hard cap on bytes the repo connector will index per file (1 MiB). */
export const MAX_REPO_INDEX_FILE_BYTES = 1 * 1024 * 1024;

/** Hard cap on shallow-clone size (100 MiB). */
export const MAX_REPO_CLONE_BYTES = 100 * 1024 * 1024;

// ---- Issue #288 — local-directory + folder-upload ingestion ---------------

/**
 * Hard cap on an uploaded .zip archive (compressed bytes), enforced by multer's
 * `limits.fileSize`. 50 MiB keeps a single multipart request bounded.
 */
export const MAX_UPLOAD_ARCHIVE_BYTES = 50 * 1024 * 1024;

/**
 * Zip-bomb guard — cap on the TOTAL uncompressed bytes a single archive may
 * expand to during extraction. Mirrors {@link MAX_REPO_CLONE_BYTES} so an
 * uploaded directory and a cloned repo are bounded the same way.
 */
export const MAX_EXTRACTED_BYTES = MAX_REPO_CLONE_BYTES;

/** Zip-bomb guard — cap on per-file uncompressed bytes during extraction. */
export const MAX_EXTRACTED_FILE_BYTES = MAX_REPO_INDEX_FILE_BYTES;

/** Zip-bomb guard — cap on the number of entries a single archive may contain. */
export const MAX_ARCHIVE_ENTRIES = 50_000;
