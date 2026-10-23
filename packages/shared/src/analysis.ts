/**
 * Analysis, AgentResult, Finding, Requirement schemas.
 */
import { z } from "zod";
import {
  ABSENCE_CLAIM_VERDICTS,
  AGENT_RESULT_STATUSES,
  ANALYSIS_AGENT_KEYS,
  ANALYSIS_SPECIALIST_AGENT_KEYS,
  ANALYSIS_STATUSES,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  FINDING_VERIFICATION_STATUSES,
  REQUIREMENT_COVERAGES,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_REVIEW_STATUSES,
  REQUIREMENT_TYPES,
  REQUIREMENT_VERDICTS,
  SUPPORT_PANEL_CONFIDENCES,
  SUPPORT_PANEL_DISCARD_REASONS,
  SUPPORT_PANEL_JUDGEMENTS,
  SUPPORT_PANEL_LENSES,
} from "./constants.js";
import type {
  FindingCategory,
  FindingSeverity,
  FindingVerificationStatus,
  RequirementCoverage,
  RequirementPriority,
  RequirementVerdict,
} from "./constants.js";
import { dateSchema, idSchema, timestampsSchema } from "./common.js";
import { githubPublishTargetSchema } from "./publishing.js";
import type { DocumentSource } from "./project.js";
import type { AgentKind, AgentRef } from "./agents.js";
import type { CrossDocFindings } from "./cross-doc.js";
import type { ImpactAffectedRelation } from "./impact.js";
import type { TestLinkRelation } from "./traceability.js";
// Type-only, and the dependency runs the other way at runtime: the presentation
// seam imports this module's types. Erased at build, so no import cycle exists.
import type { RequirementSupportConfidence } from "./support-panel-view.js";
import { DDL_CHANGE_KINDS, DDL_RISK_CLASSES, SCHEMA_RECONCILIATIONS } from "./schema-impact.js";
import type {
  DatabaseAwareAnalysisSetting,
  SchemaEdgeKind,
  SchemaSource,
} from "./schema-impact.js";

// ---- Analysis --------------------------------------------------------------
export const analysisSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    status: z.enum(ANALYSIS_STATUSES),
    startedById: idSchema,
    startedAt: dateSchema,
    completedAt: dateSchema.nullable(),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    errorMessage: z.string().max(4096).nullable(),
    metadata: z.string().nullable(),
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type Analysis = z.infer<typeof analysisSchema>;

export const createAnalysisSchema = z.object({
  projectId: idSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateAnalysisInput = z.infer<typeof createAnalysisSchema>;

// ---- AgentResult -----------------------------------------------------------
export const agentResultSchema = z
  .object({
    id: idSchema,
    analysisId: idSchema,
    agentKey: z.string().min(1).max(128),
    status: z.enum(AGENT_RESULT_STATUSES),
    startedAt: dateSchema,
    completedAt: dateSchema.nullable(),
    output: z.string().nullable(),
    errorMessage: z.string().max(4096).nullable(),
  })
  .merge(timestampsSchema);
export type AgentResult = z.infer<typeof agentResultSchema>;

export const createAgentResultSchema = z.object({
  analysisId: idSchema,
  agentKey: z.string().min(1).max(128),
});
export type CreateAgentResultInput = z.infer<typeof createAgentResultSchema>;

// ---- Finding ---------------------------------------------------------------
/**
 * Provenance enum (Epic #298 / Issue #309).
 *   - `extracted` = pulled directly from source/AST. confidence MUST be 1.0.
 *   - `inferred`  = produced by an analysis-agent's reasoning.
 *   - `ambiguous` = the agent flagged the finding for human review.
 */
export const FINDING_DERIVATIONS = ["extracted", "inferred", "ambiguous"] as const;
export type FindingDerivation = (typeof FINDING_DERIVATIONS)[number];

/**
 * Issue #1234 — the subset of {@link FINDING_DERIVATIONS} a MODEL may assert.
 * `extracted` is deliberately absent: it means "pulled directly from
 * source/AST" and carries a mandatory confidence of 1.0, which is a
 * server-side claim about provenance, not something an agent can vouch for.
 */
export const MODEL_ASSERTABLE_FINDING_DERIVATIONS = ["inferred", "ambiguous"] as const;
export type ModelAssertableFindingDerivation =
  (typeof MODEL_ASSERTABLE_FINDING_DERIVATIONS)[number];

/** Confidence persisted for an agent finding that reports none (#309 backfill value). */
export const DEFAULT_FINDING_CONFIDENCE = 0.7;

/**
 * Issue #1222 — the bucket an unrecognised MODEL-authored category lands in.
 *
 * `other` is not invented for this: it has always been the enum's designed
 * "none of the above" member, `CATEGORY_GUIDANCE` in the specialist prompts
 * already offers it to the model as exactly that, and nothing downstream
 * filters or hides it — the analysis page renders `finding.category` as a plain
 * label, and the only category-conditional logic in the codebase
 * (`synthesis.ts`, which opens a compliance or security section when a finding
 * carries that category) is purely additive. So a finding coerced here is fully
 * visible; it merely loses one word of classification instead of being lost
 * along with every other finding the agent produced.
 */
export const FALLBACK_FINDING_CATEGORY = "other" satisfies FindingCategory;

/**
 * Issue #1222 — match a model-authored category onto the closed enum, or return
 * `null` when it is not a member.
 *
 * Case and surrounding whitespace are normalised because `"Security"` is the
 * category the model meant, and sending it to {@link FALLBACK_FINDING_CATEGORY}
 * would throw away fidelity we actually have. Nothing else is guessed: there is
 * deliberately no synonym table mapping e.g. `migration` onto `architecture`,
 * because such a table is a standing invitation to encode one run's vocabulary
 * as product meaning, and the whole point of the fallback is that it generalises
 * to the word the *next* run invents.
 */
export function matchFindingCategory(value: unknown): FindingCategory | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (FINDING_CATEGORIES as readonly string[]).includes(normalized)
    ? (normalized as FindingCategory)
    : null;
}

/**
 * Issue #1222 — total version of {@link matchFindingCategory}: never throws,
 * never returns a value outside {@link FINDING_CATEGORIES}.
 *
 * Callers that need to KNOW a coercion happened (to log it) must use
 * `matchFindingCategory` and test for `null`; this function deliberately
 * discards that signal, so it is not a route to a silent no-op.
 */
export function coerceFindingCategory(value: unknown): FindingCategory {
  return matchFindingCategory(value) ?? FALLBACK_FINDING_CATEGORY;
}

export const findingSchema = z.object({
  id: idSchema,
  agentResultId: idSchema,
  category: z.enum(FINDING_CATEGORIES),
  severity: z.enum(FINDING_SEVERITIES),
  title: z.string().min(1).max(255),
  body: z.string().min(1),
  evidence: z.string().nullable(),
  derivation: z.enum(FINDING_DERIVATIONS),
  confidence: z.number().min(0).max(1),
  symbolId: idSchema.nullable().optional(),
  createdAt: dateSchema,
});
export type Finding = z.infer<typeof findingSchema>;

/**
 * Shape of a `Finding` insert.
 *
 * **This is a TYPE-ONLY artefact — it validates nothing on any write path, and
 * that is deliberate (#1325, ADR 0010).** No runtime module parses through it;
 * it exists to give {@link CreateFindingInput} a single definition, and the
 * `.refine` below documents the provenance invariant in executable form.
 *
 * The invariant `derivation === 'extracted' ⇒ confidence === 1.0` is enforced
 * at CI by a call-site ratchet — `server/tests/finding-provenance-ratchet.test.ts`
 * — not here. Calling `parse` from the writers was considered and rejected: the
 * writer that broke the rule (#1330) is precisely the one that would not have
 * opted in, so a per-finding parse in the two already-correct writers would have
 * cost a parse per row and caught nothing.
 *
 * If you make this schema load-bearing on a write path, say so here and update
 * `docs/data-model.md`, `server/prisma/schema.prisma` and the ratchet's header —
 * three previous readers were misled by comments claiming an enforcement that
 * did not exist.
 */
export const createFindingSchema = findingSchema
  .pick({
    agentResultId: true,
    category: true,
    severity: true,
    title: true,
    body: true,
    evidence: true,
    derivation: true,
    confidence: true,
    symbolId: true,
  })
  .partial({ evidence: true, symbolId: true })
  .refine((v) => !(v.derivation === "extracted" && v.confidence !== 1), {
    message: "Findings with derivation='extracted' MUST have confidence===1.0.",
    path: ["confidence"],
  });
export type CreateFindingInput = z.infer<typeof createFindingSchema>;

// ---- Requirement -----------------------------------------------------------
export const requirementSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    analysisId: idSchema,
    type: z.enum(REQUIREMENT_TYPES),
    title: z.string().min(1).max(255),
    body: z.string().min(1),
    priority: z.enum(REQUIREMENT_PRIORITIES),
    labels: z.string(), // JSON-encoded array
    storyPoints: z.number().int().min(0).max(100).nullable(),
    parentId: idSchema.nullable(),
    /**
     * Epic #726 (#736) — deterministic coverage classification computed at
     * synthesis time. Nullable: pre-#736 rows and rows for analyses whose
     * synthesis predates this field carry `null`. Defaulted so a payload that
     * omits the key entirely (older serialisations) still validates as `null`.
     */
    coverage: z.enum(REQUIREMENT_COVERAGES).nullable().default(null),
    /**
     * Issue #773 — deterministic per-requirement verdict computed at synthesis
     * from the requirement's linked CODE findings + the run's retrieval health.
     * Null when the code agent did not participate (or for pre-#773 rows).
     * Coverage says what evidence EXISTS; the verdict says whether we may tell
     * the user to build this.
     */
    verdict: z.enum(REQUIREMENT_VERDICTS).nullable().default(null),
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type Requirement = z.infer<typeof requirementSchema>;

export const createRequirementSchema = z.object({
  projectId: idSchema,
  analysisId: idSchema,
  type: z.enum(REQUIREMENT_TYPES).default("feature"),
  title: z.string().min(1).max(255),
  body: z.string().min(1),
  priority: z.enum(REQUIREMENT_PRIORITIES).default("medium"),
  labels: z.array(z.string().min(1).max(64)).max(32).default([]),
  storyPoints: z.number().int().min(0).max(100).optional(),
  parentId: idSchema.optional(),
});
export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;

// ---- Multi-agent analysis (Phase 7) ----------------------------------------

/**
 * A finding `documentId` is normally a real row id (`idSchema`, ≤64 chars). It
 * may ALSO be the synthetic `code-graph:<symbolId>` id of a fused code chunk
 * (#729/#734) — and `<symbolId>` can be a long qualified name that pushes the
 * string past 64 chars. Such a citation is normalised into a real code citation
 * downstream (`groundCodeCitations`), but that runs AFTER schema validation, so
 * the id must validate here or an over-long symbol name would discard the entire
 * finding at `agentOutputSchema.parse`. This union keeps the strict 64-char cap
 * for real ids while admitting a longer `code-graph:`-prefixed synthetic id.
 */
const documentIdSchema = z.union([idSchema, z.string().startsWith("code-graph:").max(320)]);

/**
 * Document citation reference embedded in a Finding's `evidence` JSON. Both
 * `documentId` + `chunkIndex` are required so the UI can resolve back to a
 * `KnowledgeChunk` row. This is the historical citation shape — persisted
 * findings from before code citations existed parse against it unchanged.
 */
export const documentCitationSchema = z.object({
  documentId: documentIdSchema,
  chunkIndex: z.number().int().min(0),
  filename: z.string().min(1).max(255).optional(),
  snippet: z.string().min(1).max(2048).optional(),
  score: z.number().min(0).max(1).optional(),
});
export type DocumentCitation = z.infer<typeof documentCitationSchema>;

/**
 * Epic #726 (#734) — CODE citation reference. Emitted by the code agent when a
 * finding is grounded in retrieved source, mirroring chat's #715 grounding
 * format (`filePath:startLine-endLine`). `symbolId` links back to the
 * originating code-graph symbol (Epic #725 fused chunks) when known. Validated
 * server-side against the retrieved provenance before persistence — a
 * `filePath` the model never actually retrieved is dropped, never trusted.
 */
export const codeCitationSchema = z.object({
  filePath: z.string().min(1).max(1024),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  symbolId: z.string().min(1).max(256).optional(),
  snippet: z.string().min(1).max(2048).optional(),
  score: z.number().min(0).max(1).optional(),
});
export type CodeCitation = z.infer<typeof codeCitationSchema>;

/**
 * A finding citation is EITHER a document citation or a code citation. The
 * union is tolerant, not discriminated by a literal tag: a document citation
 * has `documentId`+`chunkIndex` (and no `filePath`), a code citation has
 * `filePath`+`startLine`+`endLine` (and no `documentId`). Document citations
 * are tried first so every pre-#734 payload validates byte-identically.
 */
export const citationSchema = z.union([documentCitationSchema, codeCitationSchema]);
export type Citation = z.infer<typeof citationSchema>;

/**
 * #573 — a document citation as the analysis snapshot returns it: the stored
 * citation plus the cited row's `documents.source`, read at read time so it is
 * right for findings persisted before it existed. Absent when the document row
 * did not resolve. Never part of {@link documentCitationSchema}, so a model
 * cannot assert it.
 */
export type SnapshotDocumentCitation = DocumentCitation & { source?: DocumentSource };
/** #573 — a finding citation on the analysis snapshot. */
export type SnapshotCitation = SnapshotDocumentCitation | CodeCitation;

/**
 * Issue #1143 — what {@link salvageCitationList} did to one finding's
 * citations. `dropped` counts citations lost (invalid after repair, or past the
 * cap); `repaired` counts fixes that lost nothing (a `null` optional field
 * removed, a `null` list read as empty, a lone citation wrapped in a list).
 */
export interface CitationSalvage {
  citations: unknown;
  dropped: number;
  repaired: number;
}

/**
 * Issue #1143 — a model-authored citation list, repaired where it can be and
 * otherwise thinned, never rejected whole. Measured on the Claude A/B for
 * #1074: one citation matching no union branch (`symbolId: null`, no
 * `documentId`, `startLine: 0`) made `agentOutputSchema` throw, and the
 * document and code agents were each recorded `failed` with every finding they
 * had produced discarded. Each citation is now tried on its own: a `null` in
 * an optional field is dropped (the repair), a citation still invalid after
 * that is dropped, and the finding keeps the citations that validate. The list
 * is cut to its cap rather than failing on it.
 *
 * The list itself is repaired the same way: `citations: null` is an empty list,
 * and a lone value where the list belongs is a list of one, then validated like
 * any other element. Only `undefined` passes through, for `.default([])`.
 *
 * Returns the counts rather than reporting them, so the schema stays a plain
 * value usable by every caller; a caller that must say what was lost reads the
 * same counts with {@link collectSalvagedCitations} before it parses.
 *
 * Model boundary only, like {@link coerceFindingCategory}: persisted evidence is
 * parsed elsewhere, and the #734 grounding gate still checks every surviving
 * code citation against what the agent actually retrieved.
 */
export function salvageCitationList(value: unknown): CitationSalvage {
  if (value === undefined) return { citations: undefined, dropped: 0, repaired: 0 };
  if (value === null) return { citations: [], dropped: 0, repaired: 1 };
  let repaired = 0;
  let list: unknown[];
  if (Array.isArray(value)) {
    list = value;
  } else {
    list = [value];
    repaired += 1;
  }
  const kept: Citation[] = [];
  let dropped = 0;
  for (const raw of list) {
    const isObject = raw !== null && typeof raw === "object" && !Array.isArray(raw);
    const entries = isObject ? Object.entries(raw) : [];
    const withoutNulls = entries.filter(([, v]) => v !== null);
    const parsed = citationSchema.safeParse(isObject ? Object.fromEntries(withoutNulls) : raw);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    if (withoutNulls.length < entries.length) repaired += 1;
    kept.push(parsed.data);
  }
  dropped += Math.max(0, kept.length - MAX_FINDING_CITATIONS);
  return { citations: kept.slice(0, MAX_FINDING_CITATIONS), dropped, repaired };
}

/** The citation list {@link salvageCitationList} keeps: the schema's preprocess step. */
export function salvageCitations(value: unknown): unknown {
  return salvageCitationList(value).citations;
}

/**
 * Issue #1143 — the salvage totals across a model's whole answer (its
 * `findings[].citations`), read before the parse that erases them. Pure and
 * total: any shape returns counts, never throws.
 */
export function collectSalvagedCitations(output: unknown): { dropped: number; repaired: number } {
  const total = { dropped: 0, repaired: 0 };
  if (output === null || typeof output !== "object" || Array.isArray(output)) return total;
  const findings = (output as Record<string, unknown>).findings;
  if (!Array.isArray(findings)) return total;
  for (const f of findings) {
    if (f === null || typeof f !== "object" || Array.isArray(f)) continue;
    const s = salvageCitationList((f as Record<string, unknown>).citations);
    total.dropped += s.dropped;
    total.repaired += s.repaired;
  }
  return total;
}

/** Most citations one finding carries. */
export const MAX_FINDING_CITATIONS = 20;

/** Narrow a {@link Citation} to a {@link CodeCitation} (has a `filePath`). */
export function isCodeCitation(c: Citation): c is CodeCitation {
  return typeof (c as Partial<CodeCitation>).filePath === "string";
}

/** Narrow a {@link Citation} to a {@link DocumentCitation} (has a `documentId`). */
export function isDocumentCitation(c: Citation): c is DocumentCitation {
  return typeof (c as Partial<DocumentCitation>).documentId === "string";
}

/**
 * Render a code citation as the canonical `filePath:startLine-endLine` locator
 * (chat #715 format). Shared so server prompts and the UI never diverge on the
 * exact rendering.
 */
export function formatCodeCitationLocator(c: CodeCitation): string {
  return `${c.filePath}:${c.startLine}-${c.endLine}`;
}

/**
 * Persona descriptor surfaced in the UI alongside each agent. Mary / Winston
 * / Sally / Quinn are the BMAD-METHOD inspired defaults; deployments may
 * override via `ANALYSIS_PERSONA_*` env vars (see analysis-orchestrator).
 */
export const analysisPersonaSchema = z.object({
  agentKey: z.enum(ANALYSIS_AGENT_KEYS),
  name: z.string().min(1).max(64),
  role: z.string().min(1).max(120),
  avatar: z.string().min(1).max(8),
  description: z.string().min(1).max(280),
});
export type AnalysisPersona = z.infer<typeof analysisPersonaSchema>;

// ---- Multi-lens support panel (Epic #1107 / #1109) -------------------------

/**
 * One lens's contribution to the panel. Persisted verbatim so a reader can audit
 * WHY a finding carries the confidence it does, rather than being handed a score.
 *
 * `judgement` is `null` EXACTLY WHEN the vote was not counted, and `counted`
 * restates that so a consumer cannot accidentally read a discarded vote as a
 * judgement. A `no-signal` discard is the panel failing, not the finding failing.
 */
export const supportPanelVoteSchema = z.object({
  lens: z.enum(SUPPORT_PANEL_LENSES),
  /** The lens's judgement, or `null` when the vote was discarded. */
  judgement: z.enum(SUPPORT_PANEL_JUDGEMENTS).nullable(),
  /** Null when the vote counted; otherwise why it did not. */
  discardReason: z.enum(SUPPORT_PANEL_DISCARD_REASONS).nullable(),
  /**
   * The decisive `path/to/file.ts:120` (or `:120-140`) locator the lens cited,
   * validated against the evidence the lens was actually shown. Null when it
   * cited nothing citable — in which case the vote is discarded, never counted.
   */
  citation: z.string().max(1024).nullable(),
  /** The lens's own words. Truncated, never interpreted. */
  reasoning: z.string().max(2000),
  /** Did this vote enter the tally? Equivalent to `discardReason === null`. */
  counted: z.boolean(),
});
export type SupportPanelVote = z.infer<typeof supportPanelVoteSchema>;

/** Token/call cost of ONE finding's panel, so per-run cost is auditable per finding. */
export const supportPanelUsageSchema = z.object({
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  /** Provider round-trips, INCLUDING #1114 re-prompts. A 3-lens panel is ≥3. */
  llmCalls: z.number().int().min(0),
});
export type SupportPanelUsage = z.infer<typeof supportPanelUsageSchema>;

/**
 * Epic #1107 (#1111 / A3) — the verdict on ONE absence-shaped claim.
 *
 * Only present on findings a detector judged to ASSERT AN ABSENCE, which is why
 * it hangs off the panel rather than off every finding: the three generic lenses
 * ask *"does the evidence back this claim?"*, a question that structurally
 * cannot be answered for a claim about what is NOT there. This field answers the
 * question that can be: *"is the thing said to be missing present in what we
 * retrieved, absent from it, or outside it altogether?"*
 *
 * Four legible states, never three:
 *
 * ```
 *   verdict = "supported"     we looked at the right place; it is not there
 *   verdict = "contradicted"  it IS there — `citation` names where
 *   verdict = "unexamined"    the evidence to judge was never retrieved
 *   verdict = null            the VERIFIER produced no verdict (#1114 no-signal)
 * ```
 *
 * The `null` branch is a fact about the verifier, not about the codebase, and
 * `noSignalReason` is set exactly then. It is modelled as `null` rather than as
 * a fourth enum member so a consumer switching on {@link AbsenceClaimVerdict}
 * physically cannot read a verifier failure as an evidence judgement.
 */
export const findingAbsenceCheckSchema = z.object({
  /** The evidence verdict, or `null` when the verifier itself produced none. */
  verdict: z.enum(ABSENCE_CLAIM_VERDICTS).nullable(),
  /**
   * The decisive `path/to/file.ts:120` locator, grounded against the excerpts the
   * verifier was actually shown. **Required for `contradicted`** — a claim that
   * "the thing IS there" is worthless without saying where — and required for
   * `supported` too, which must name where it looked. `unexamined` may have none,
   * because there was nowhere relevant to point at.
   */
  citation: z.string().max(1024).nullable(),
  /** The verifier's own words, truncated, never interpreted. */
  reasoning: z.string().max(2000),
  /**
   * Set when the raw model verdict was DETERMINISTICALLY downgraded to
   * `unexamined` for want of a grounded locator. The downgrade only ever runs
   * toward `unexamined`: an ungrounded "we looked and it is absent" is exactly
   * the unverified confidence #773 is about, and an ungrounded "it is there"
   * cannot be actioned. Recorded so the downgrade is auditable rather than silent.
   */
  downgradedFrom: z.enum(ABSENCE_CLAIM_VERDICTS).nullable(),
  /** Why the verifier produced nothing (#1114). Non-null exactly when `verdict` is null. */
  noSignalReason: z.string().max(200).nullable(),
});
export type FindingAbsenceCheck = z.infer<typeof findingAbsenceCheckSchema>;

/**
 * Epic #1107 (#1109) — the panel's verdict on ONE finding, persisted alongside
 * (never instead of) the deterministic #740 `verificationStatus`.
 *
 * THIS IS A CONFIDENCE SIGNAL, NOT A GATE. Nothing in this object removes a
 * finding, and no combination of votes may: METIS is recall-first, a dropped
 * requirement is invisible to the user, and #1101 is what that costs. A2 (#1110)
 * decides how the signal is presented and ranked; A3 (#1111) extends it to
 * absence claims.
 */
export const findingSupportPanelSchema = z.object({
  /** Aggregate label, computed by a PURE tally in code — never by a model. */
  confidence: z.enum(SUPPORT_PANEL_CONFIDENCES),
  /** Every lens's contribution, counted or not, in lens order. */
  votes: z.array(supportPanelVoteSchema).max(8),
  /** Votes that entered the tally (`judgement !== null`). */
  countedVotes: z.number().int().min(0),
  supportedVotes: z.number().int().min(0),
  unsupportedVotes: z.number().int().min(0),
  uncertainVotes: z.number().int().min(0),
  /** Lenses that produced no parseable verdict (#1114). NEVER negative votes. */
  noSignalVotes: z.number().int().min(0),
  /** Lenses that judged but cited no usable `file:line`, so were not counted. */
  uncitedVotes: z.number().int().min(0),
  /**
   * Epic #1107 (#1111 / A3) — present ONLY on findings detected as asserting an
   * absence, absent (never `null`) on every other finding, so a non-absence
   * finding's persisted panel is byte-identical to a pre-#1111 one.
   *
   * It feeds {@link FindingSupportPanel.confidence} through a pure rule that can
   * only ever LOWER it: `contradicted` forces `low`, `unexamined` caps at
   * `medium`, `supported` changes nothing. A single verifier call may not
   * overturn three dissenting lenses in the finding's favour.
   */
  absenceCheck: findingAbsenceCheckSchema.nullish(),
  usage: supportPanelUsageSchema,
});
export type FindingSupportPanel = z.infer<typeof findingSupportPanelSchema>;

/**
 * Epic #1316 (#1318) — ONE claim-level faithfulness number, reported by the
 * analysis pipeline in the SAME shape and on the SAME scale docs-gen reports.
 *
 * Before this, "how grounded is METIS output?" had two incompatible answers: a
 * numeric supported/total ratio for docs-gen sections, and a categorical
 * `confirmed`/`unverified`/`could-not-verify` for the analysis findings
 * operators actually publish. A groundedness regression in one pipeline was
 * invisible to the other's gate.
 *
 * THIS IS A METRIC, NOT A GATE, and it is strictly ADDITIVE. It never replaces
 * `verificationStatus` and nothing reads it to decide a verdict, a severity, a
 * ranking or a deletion — the #1109 grader rule, one field further on.
 *
 * `score === null` means UNVERIFIABLE — not low, not high. It is EXCLUDED from
 * means rather than counted as a pass, because a metric that read 1.0 whenever
 * the judge was unavailable would report the product healthiest exactly when it
 * knew least (the `StubRagasJudge` defect #1317 calls out).
 */
export const findingFaithfulnessSchema = z
  .object({
    /** supported/total in [0,1], or `null` when the judge could not verify. */
    score: z.number().min(0).max(1).nullable(),
    totalClaims: z.number().int().min(0),
    supportedClaims: z.number().int().min(0),
    /** Present exactly when {@link findingFaithfulnessSchema} `score` is `null`. */
    unverifiableReason: z.enum(["no-evidence", "no-claims", "judge-unavailable"]).nullish(),
  })
  // The two invariants above are ENFORCED, not merely documented, because this
  // schema is what validates a blob on the way OUT of the database as well as
  // in (`coerceFaithfulness`). Neither violation can be produced by
  // `toFaithfulnessMetric`, so a value with that shape is corrupt or forged and
  // must read as "not measured" rather than render as a measurement.
  .superRefine((m, ctx) => {
    if (m.supportedClaims > m.totalClaims) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supportedClaims"],
        message: "supportedClaims cannot exceed totalClaims",
      });
    }
    // A number AND "I could not verify" is not a measurement — a reader would
    // believe the number. An explicit `null` reason is just an absent one.
    if (m.score !== null && m.unverifiableReason != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unverifiableReason"],
        message: "unverifiableReason is only valid when score is null",
      });
    }
    if (m.score === null && m.unverifiableReason == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unverifiableReason"],
        message: "an unverifiable score must say why it could not be verified",
      });
    }
  });
export type FindingFaithfulness = z.infer<typeof findingFaithfulnessSchema>;

/** Validated structured output of a single specialist agent. */
export const agentFindingPayloadSchema = z.object({
  /**
   * Issue #1222 — coerced, not rejected. Measured live on Bedrock
   * (`us.anthropic.claude-sonnet-5`, OrderBatch): the `document` and `database`
   * agents emitted `"info"` and `"migration"`, the enum rejected them, this
   * schema threw, and BOTH agents were recorded `failed` with every finding
   * they had produced discarded. The JSON was well-formed — the model simply
   * chose a reasonable-sounding word outside a closed set it was shown as a
   * bare pipe-delimited list.
   *
   * This is the #1230 rule, one field further on: a malformed value in a
   * classification field must never cost a whole run's findings. The preprocess
   * sits HERE rather than in `runAgent` because there are five parse sites for
   * model-authored findings — `agent-runner.ts` (single-shot), two in
   * `orchestrator.ts` (agentic), and the per-finding `safeParse` in
   * `agentic-degradation.ts`, where an out-of-enum category silently DELETED
   * that one finding from the salvage set.
   *
   * Deliberately narrower than #1231's `clampAgentOutputStrings`, whose
   * documented invariant is that it "cannot relax an enum": clamping only ever
   * shortens a value, so widening it to rewrite enums would have broken that
   * contract and its test. This is the sibling mechanism, not an extension.
   *
   * {@link findingSchema} — the PERSISTED shape — stays strict. Leniency
   * belongs at the model boundary only; a stored row outside the enum is a real
   * data defect and must still surface.
   */
  category: z.preprocess(coerceFindingCategory, z.enum(FINDING_CATEGORIES)),
  severity: z.enum(FINDING_SEVERITIES),
  title: z.string().min(1).max(255),
  body: z.string().min(1).max(4096),
  /** Issue #1143 — salvaged per citation, never rejected whole: {@link salvageCitations}. */
  citations: z
    .preprocess(salvageCitations, z.array(citationSchema).max(MAX_FINDING_CITATIONS))
    .default([]),
  tags: z.array(z.string().min(1).max(64)).max(16).default([]),
  /**
   * Epic #912 (#916/#920) — id of the extracted requirement this finding is
   * grounded in (e.g. `REQ-003`). Null/absent for findings that do not trace
   * to a specific requirement (generic specialist observations). Surfaced in
   * the UI as a "Gap for REQ-003" badge.
   */
  requirementId: z.string().min(1).max(128).nullish(),
  /**
   * Epic #727 (#740) — verification status set by the deterministic verifier
   * pass AFTER the #734 grounding gate, BEFORE synthesis. NOT authored by the
   * model: the orchestrator overwrites whatever the model emits with the
   * verifier's verdict (see `verifyFinding`). Null/absent for findings that make
   * no code-evidence claim, and for legacy findings persisted before #740.
   */
  verificationStatus: z.enum(FINDING_VERIFICATION_STATUSES).nullish(),
  /**
   * Issue #773 — the verdict this finding reaches about its requirement:
   * `implemented` | `gap-confirmed` | `could-not-verify`. The MODEL authors a
   * first draft of this (it is the only party that knows what its investigation
   * meant), but the server GATES it deterministically before persistence
   * (`gateFindingVerdict`): a `gap-confirmed` claim is DOWNGRADED to
   * `could-not-verify` unless the run's retrieval actually met the evidence
   * threshold, and an `implemented` claim is downgraded unless the finding cites
   * code that survived the #734 provenance gate. The gate can only ever weaken a
   * claim — never strengthen one. Absent on non-code agents and legacy findings.
   */
  verdict: z.enum(REQUIREMENT_VERDICTS).nullish(),
  /**
   * Epic #1107 (#1109) — the multi-lens support panel's confidence signal, set
   * by the orchestrator AFTER the deterministic verifier, and only when
   * `ANALYSIS_LLM_SUPPORT_PANEL` is on. Like `verificationStatus` it is NOT
   * authored by the model: the orchestrator overwrites whatever a model emits
   * here. Absent (never `null`) when the flag is off, so a flag-off run persists
   * byte-identically to a pre-#1109 run.
   */
  supportPanel: findingSupportPanelSchema.nullish(),
  /**
   * Epic #1316 (#1318) — claim-level faithfulness of THIS finding against the
   * evidence the run retrieved, set by the orchestrator AFTER the deterministic
   * verifier and only when `ANALYSIS_FAITHFULNESS_METRIC` is on, on the agent
   * paths that run the graders (the agentic and grounded `code` passes).
   *
   * NOT authored by the model, like `verificationStatus` and `supportPanel` —
   * but unlike those two the rule is ENFORCED rather than assumed. The field is
   * accepted here so the orchestrator can carry its own value on the object it
   * persists; the server refuses any value it did not itself author at the
   * storage boundary (`persistAgentResult` +
   * `server/src/lib/analysis/server-authored.ts`). That is what makes the
   * flag-off promise below true on EVERY path, including the specialist agents
   * that persist `runAgent` output with no grader in between.
   *
   * ADDITIVE ONLY. It sits ALONGSIDE `verificationStatus`, never instead of it.
   * Absent (never `null`) when the flag is off, so a flag-off run persists
   * byte-identically to a pre-#1318 run.
   */
  faithfulness: findingFaithfulnessSchema.nullish().catch(undefined),
  /**
   * Issue #1234 — the agent's own probability that the finding is correct.
   * Before #1234 this was hardcoded to {@link DEFAULT_FINDING_CONFIDENCE} for
   * every agent finding, so the badge rendered a constant.
   *
   * `.catch(undefined)` is load-bearing, not defensive noise: a model that
   * emits `2`, `-1`, `NaN` or `"high"` here must fall back to the default, NOT
   * fail `agentOutputSchema.parse` and discard a completed investigation. That
   * is the #1230 rule — a malformed value in a low-stakes field must never cost
   * a whole run's findings.
   */
  confidence: z.number().min(0).max(1).nullish().catch(undefined),
  /**
   * Issue #1234 — how the agent arrived at the finding. Restricted to
   * {@link MODEL_ASSERTABLE_FINDING_DERIVATIONS}: `ambiguous` is how an agent
   * flags a shaky finding for human review (the analysis page's review
   * affordance gates on exactly this value and was unreachable before #1234),
   * and `extracted` is rejected here so a model cannot claim confidence 1.0.
   * Unknown values fall back rather than throwing, for the same #1230 reason.
   */
  derivation: z.enum(MODEL_ASSERTABLE_FINDING_DERIVATIONS).nullish().catch(undefined),
});
export type AgentFindingPayload = z.infer<typeof agentFindingPayloadSchema>;

export const agentOutputSchema = z.object({
  agentKey: z.enum(ANALYSIS_AGENT_KEYS),
  summary: z.string().min(1).max(2048),
  findings: z.array(agentFindingPayloadSchema).max(50),
  notes: z.array(z.string().min(1).max(512)).max(20).default([]),
});
export type AgentOutput = z.infer<typeof agentOutputSchema>;

/**
 * A single atomic requirement the document specialist extracts alongside its
 * findings (#750). Emitted as part of the document agent's normal structured
 * output — NOT a separate LLM call. `source` is best-effort provenance the
 * model may omit. Read back by the orchestrator to route the code agent into
 * agentic / requirement-grounded mode (`detectAgentMode`).
 */
export const documentRequirementSchema = z.object({
  id: z.string().min(1).max(128),
  text: z.string().min(1).max(2048),
  source: z
    .object({
      documentId: z.string().max(256).optional(),
      chunkIndex: z.number().int().min(0).optional(),
    })
    .optional(),
});
export type DocumentRequirement = z.infer<typeof documentRequirementSchema>;

/**
 * The document specialist's validated output (#750). A superset of
 * {@link agentOutputSchema} that RETAINS the extracted `requirements` array.
 *
 * The base `agentOutputSchema` strips unknown keys (Zod's default), which is
 * exactly why requirement extraction silently yielded `[]` and the code agent
 * never left single-shot mode. Only the DOCUMENT agent is validated against
 * this schema; every other specialist keeps the strict base schema, so this
 * does NOT relax validation for other agents.
 */
export const documentAgentOutputSchema = agentOutputSchema.extend({
  requirements: z.array(documentRequirementSchema).max(200).default([]),
});
export type DocumentAgentOutput = z.infer<typeof documentAgentOutputSchema>;

/** Validated structured output of the LLM synthesis agent (#56). */
export const synthesizedRequirementSchema = z.object({
  type: z.enum(REQUIREMENT_TYPES).default("feature"),
  title: z.string().min(1).max(255),
  body: z.string().min(1).max(4096),
  priority: z.enum(REQUIREMENT_PRIORITIES).default("medium"),
  labels: z.array(z.string().min(1).max(64)).max(16).default([]),
  storyPoints: z.number().int().min(0).max(100).optional(),
  /** Indices into the merged finding list that this requirement is grounded in. */
  evidenceFindingIndexes: z.array(z.number().int().min(0)).max(50).default([]),
  /**
   * Issue #1096 — testable acceptance criteria derived from THIS requirement's
   * evidence, as first-class structured data rather than prose buried in `body`.
   *
   * Defaults to `[]`: an empty array is a truthful "none could be derived" and is
   * rendered as such downstream. It must never be back-filled with boilerplate —
   * the bug being fixed is that draft bodies papered over the absence with a
   * generic Given/When/Then block that read as authored.
   */
  acceptanceCriteria: z.array(z.string().min(1).max(1024)).max(20).default([]),
  /**
   * Issue #1063 — on a run started from imported items, the `NR-*` ids of the
   * items this requirement restates or refines. `[]` is the model saying the
   * requirement is its own addition; ABSENT means it did not say, which must
   * never be read as "added by the analysis". No default, for that reason.
   * Model output: every id is checked against the run's own before it is kept
   * (`cleanSourceIds`), which is also where unknown and over-long ids go.
   *
   * FAILS SOFT, and must: `runSynthesis` validates the whole reply with
   * {@link synthesisOutputSchema}, so a strict schema here let one requirement's
   * `sourceIds: null` discard every requirement of the reply, twice, for a field
   * that only says where a card came from. Anything that is not a list (`null`,
   * a bare string, a number) reads as ABSENT; an entry that is not a string
   * reads as `""`, which is no run's id. No length caps: an id the run does not
   * list is dropped whatever its length, so a cap could only reject the reply.
   */
  sourceIds: z.array(z.string().catch("")).optional().catch(undefined),
  /**
   * Issue #1033 — the ids of the EXTRACTED (structured) requirements this
   * requirement restates, so promotion joins its criteria and evidence onto the
   * reviewed requirement by id. Joining by title alone gave a consolidated
   * item to one of the requirements it covered and left the rest with no
   * criteria and no code link. ABSENT means the model did not say, and the
   * title join applies. Fails soft for the same reason as `sourceIds`; ids not
   * in the run's list are dropped in `runSynthesis`.
   */
  structuredIds: z.array(z.string().catch("")).optional().catch(undefined),
});
export type SynthesizedRequirement = z.infer<typeof synthesizedRequirementSchema>;

/**
 * Issue #1096 — parse the persisted `Requirement.acceptanceCriteria` JSON column
 * into a string array. Anything unparseable, non-array, or blank yields `[]`,
 * which downstream renders as an explicit "none were derived" note rather than
 * as placeholder criteria.
 */
export function parseAcceptanceCriteria(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  } catch {
    return [];
  }
}

export const synthesisOutputSchema = z.object({
  summary: z.string().min(1).max(4096),
  requirements: z.array(synthesizedRequirementSchema).max(100),
});
export type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;

// \u2500\u2500 Synthesis degradation (Issue #1117, findings B + C) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// `runSynthesis` has always had a deterministic fallback: when the LLM call
// fails, returns non-JSON, fails schema validation, or yields zero
// requirements, findings are clustered by keyword overlap instead. That
// fallback cannot classify anything, so it hardcodes `type: "feature"` and
// `acceptanceCriteria: []` on EVERY requirement it emits.
//
// Until now it was completely silent. A verification walkthrough saw 16/16
// requirements typed `feature` (including two security defects) and 0/16 with
// acceptance criteria, and had to reverse-engineer the cause from the run's
// persisted summary string. The run itself reported `completed`.
//
// These types live in `@metis/shared` on purpose: ten pipeline test suites
// `vi.mock("./synthesis.js")` exposing only `runSynthesis`, so a new *value*
// export on that module would throw at runtime in every one of them.

/** Why synthesis fell back to the deterministic clusterer. */
export const SYNTHESIS_DEGRADATION_REASONS = [
  /** `provider.chat` threw (network, auth, cost cap, timeout). */
  "provider-error",
  /** The response body could not be parsed as JSON (commonly truncated output). */
  "non-json",
  /** Valid JSON that did not satisfy `synthesisOutputSchema`. */
  "schema-invalid",
  /** Well-formed output that contained no requirements at all. */
  "empty-requirements",
] as const;

export type SynthesisDegradationReason = (typeof SYNTHESIS_DEGRADATION_REASONS)[number];

/**
 * A durable record of one degraded synthesis run. Persisted to
 * `Analysis.metadata.synthesisDegraded` (additive, no migration).
 */
export interface SynthesisDegradation {
  reason: SynthesisDegradationReason;
  /** Provider/parser message, truncated. Absent when there was nothing to say. */
  detail?: string;
  /** How many LLM attempts were made in total before giving up (>= 1). */
  attempts: number;
  /** How many requirements the deterministic fallback ended up emitting. */
  requirementCount: number;
  /**
   * #751 — on a PARTIAL run, how many requirements the model wrote (typed,
   * with acceptance criteria) and were kept alongside the
   * {@link requirementCount} keyword-grouped ones. Absent or 0 when the whole
   * set came from the fallback, which is how every record before #751 reads.
   */
  modelRequirementCount?: number;
  /**
   * #868 review — findings the 100-requirement cap left out of EVERY
   * requirement, model-written or grouped. Absent or 0 when every finding is
   * in some requirement; the notice says "Nothing was dropped" only then.
   */
  findingsWithoutRequirement?: number;
  /** ISO timestamp of the degraded run. */
  at: string;
}

const DEGRADATION_CAUSE: Record<SynthesisDegradationReason, string> = {
  "provider-error": "the model call failed",
  "non-json": "the model did not return parseable JSON",
  "schema-invalid": "the model's JSON did not match the required shape",
  "empty-requirements": "the model returned no requirements",
};

/**
 * The sentence a user needs in order to understand a degraded run WITHOUT
 * reading the source: what happened, and the two specific output properties it
 * explains. Both consequences are named because each one independently looks
 * like a different bug \u2014 "the classifier regressed" and "the acceptance-criteria
 * deriver never fired" were filed as separate findings for exactly this reason.
 */
export function describeSynthesisDegradation(degradation: SynthesisDegradation): string {
  const { reason, attempts, requirementCount } = degradation;
  const attemptNote = attempts > 1 ? ` after ${attempts} attempts` : "";
  const count = requirementCount === 1 ? "requirement" : "requirements";
  const modelCount = degradation.modelRequirementCount ?? 0;
  const lost = degradation.findingsWithoutRequirement ?? 0;
  // #868 review — "Nothing was dropped" is a claim, made only when it is true.
  const lostNote =
    lost > 0
      ? `${lost} ${lost === 1 ? "finding is" : "findings are"} in no requirement, because the ` +
        `100-requirement limit was reached.`
      : "Nothing was dropped.";
  if (modelCount > 0) {
    // #751 — a partial run: most of the list IS typed and has criteria, so the
    // whole-fallback sentence ("every requirement is typed feature") is false.
    const counted = (n: number): string =>
      `${n} ${n === 1 ? "requirement was" : "requirements were"}`;
    return (
      `Requirement synthesis was partly degraded: ${DEGRADATION_CAUSE[reason]}${attemptNote}. ` +
      `${counted(modelCount)} written by the model, with model-assigned types and acceptance ` +
      `criteria. The other ${counted(requirementCount)} grouped deterministically by keyword ` +
      `overlap from findings no model call reached — those are typed "feature" and have ` +
      `no acceptance criteria because the fallback cannot derive them. ${lostNote} ` +
      `Re-run the analysis to get model-assigned types and criteria for all of them.`
    );
  }
  return (
    `Requirement synthesis was degraded: ${DEGRADATION_CAUSE[reason]}${attemptNote}, ` +
    `so the ${requirementCount} ${count} below were grouped deterministically by keyword ` +
    `overlap instead. ${lost > 0 ? `${lostNote} Nothing` : "Nothing was dropped, but nothing"} ` +
    `was classified either \u2014 every ` +
    `requirement is typed "feature" and has no acceptance criteria because the fallback ` +
    `cannot derive them. Re-run the analysis to get model-assigned types and criteria.`
  );
}

/**
 * Issue #769 \u2014 why a re-synthesis was refused permission to replace the
 * analysis's requirement set.
 *
 * - `reviewed-work`: at least one existing requirement carries human work
 *   (a review status, an edit, a link, a data mapping, a baseline pin, a review
 *   item, a comment thread or an assignment). Replacing the set hard-deletes it.
 * - `degraded-synthesis`: the new synthesis fell back to the keyword clusterer
 *   while the existing set came from a healthy one.
 */
export type RequirementReplacementWithheldReason = "reviewed-work" | "degraded-synthesis";

/**
 * Durable record of a refused replacement. Persisted to
 * `Analysis.metadata.requirementReplacementWithheld` (additive, no migration)
 * and cleared the next time a replacement is allowed.
 */
export interface RequirementReplacementWithheld {
  reason: RequirementReplacementWithheldReason;
  /** Requirements kept (the set that was NOT replaced). */
  existingCount: number;
  /** How many of the kept requirements carry human review work. */
  reviewedCount: number;
  /** Requirements the refused synthesis produced (not persisted). */
  proposedCount: number;
  /** ISO timestamp of the refusal. */
  at: string;
  /**
   * Issue #780 — the refused result was kept, so the analyst can compare it
   * with the current set and apply or dismiss it. Absent on refusals recorded
   * before #780, which kept nothing.
   */
  proposalStored?: boolean;
}

/** Issue #780 — a requirement field the withheld-replacement comparison shows. */
export type WithheldReplacementField =
  "title" | "description" | "priority" | "type" | "acceptanceCriteria";

/** Issue #780 — one field that differs between the current and proposed requirement. */
export interface WithheldReplacementFieldChange {
  field: WithheldReplacementField;
  /** Text fields as written; acceptance criteria as their list. */
  before: string | string[];
  after: string | string[];
}

/**
 * Issue #780 — what applying a withheld re-synthesis does to one requirement.
 *
 * - `add`: a new requirement is created.
 * - `replace`: a requirement with no review work is replaced, as a re-run does.
 * - `update`: a reviewed requirement is changed through version history,
 *   keeping its status, links, comments and other review work.
 * - `delete`: a requirement with no review work that the new result leaves out.
 * - `keep`: a reviewed requirement the new result leaves out; never deleted.
 * - `skip`: the new result restates a requirement someone deleted; not restored.
 */
export type WithheldReplacementOutcome = "add" | "replace" | "update" | "delete" | "keep" | "skip";

export interface WithheldReplacementEntry {
  /** The requirement's title (the current one where there is one). */
  title: string;
  outcome: WithheldReplacementOutcome;
  /** Whether the current requirement carries review work. False for `add`. */
  reviewed: boolean;
  /** The current requirement's review status, when it has one. */
  reviewStatus: string | null;
  /** Fields that differ; empty for add / delete / keep / skip. */
  changes: WithheldReplacementFieldChange[];
  /** For `add`: what the new requirement would hold. */
  proposed?: {
    type: string;
    priority: string;
    description: string;
    acceptanceCriteria: string[];
  };
}

/**
 * Issue #780 — `GET /api/projects/:projectId/analyses/:id/withheld-replacement`.
 * The comparison of the current requirement set with the withheld one.
 */
export interface WithheldReplacementDiff {
  withheld: RequirementReplacementWithheld;
  added: WithheldReplacementEntry[];
  changed: WithheldReplacementEntry[];
  removed: WithheldReplacementEntry[];
  /** Restatements of deleted requirements, which applying will not restore. */
  skipped: WithheldReplacementEntry[];
  /** Current requirements the new result restates without a change. */
  unchangedCount: number;
}

/** Issue #780 — the result of applying a withheld re-synthesis. */
export interface WithheldReplacementApplyResult {
  added: number;
  replaced: number;
  updated: number;
  deleted: number;
  kept: number;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The sentence a user reads when a re-synthesis was not applied (#769). */
export function describeRequirementReplacementWithheld(
  withheld: RequirementReplacementWithheld,
): string {
  const { reason, existingCount, reviewedCount, proposedCount } = withheld;
  const kept =
    `METIS kept the existing ${existingCount} ` +
    `${plural(existingCount, "requirement", "requirements")} unchanged`;
  const discarded =
    `The ${proposedCount} newly synthesized ` +
    `${plural(proposedCount, "requirement was", "requirements were")} not applied.`;
  if (reason === "degraded-synthesis") {
    return (
      `${kept}: the latest re-synthesis was degraded (the model output could not be used), ` +
      `and a degraded result never overwrites a successful one. ${discarded}`
    );
  }
  return (
    `${kept}, because ${reviewedCount} of them ` +
    `${plural(reviewedCount, "carries", "carry")} review work (a review status, edit, link, ` +
    `data mapping, baseline pin, comment or assignment) that a re-synthesis would have ` +
    `deleted. ${discarded}`
  );
}

/**
 * Request body for `POST /api/projects/:projectId/analyses` \u2014 lets the UI
 * scope which documents and agents participate in the run.
 */
/**
 * Maximum characters accepted in the free-text "new requirements" box.
 *
 * Issue #1112 — single source of truth for the three places that used to
 * hardcode 4,096 independently (this schema, the UI textarea's `maxLength` +
 * slice, and the server-side truncation check). A paste that reaches this length
 * lost its tail before METIS ever saw it, so both the textarea and the run's
 * input account must SAY so rather than trimming in silence (#1101).
 */
export const MAX_EXTRA_INSTRUCTIONS = 4096;

/** Most imported requirements one analysis can start from (`importedRequirementIds`). */
export const MAX_IMPORTED_REQUIREMENTS_PER_ANALYSIS = 25;
/**
 * Issue #994 — what a Spec Kit "Start analysis" handoff sent. `artifacts` are
 * the files `/speckit.implement` forwarded; `sent` names the requirements
 * carried in `extraInstructions` (`AC-1`, `NFR-1`, …); `omitted` names those
 * that did not fit {@link MAX_EXTRA_INSTRUCTIONS} (or `the end of spec.md` when
 * the spec had no acceptance criteria to send one by one). Persisted as
 * `metadata.specKitHandoff`, so the analysis page itself says what was left
 * out — a toast before the redirect was never seen.
 */
/**
 * Most entries `specKitHandoff.sent` / `omitted` may hold. A client with more
 * omitted requirements than this keeps the first `max - 1` and ends the list
 * with a `+N more` entry, rather than having the whole run rejected.
 */
export const SPEC_KIT_HANDOFF_MAX_LABELS = 500;

/**
 * Issue #1027 — most characters accepted in `agentContext`: background the code
 * agent reads next to the requirements (a Spec Kit handoff fills it from
 * plan.md's components and tasks.md's task ids and titles). It is a separate
 * limit from {@link MAX_EXTRA_INSTRUCTIONS} because the text is never split
 * into requirements. About 1,024 tokens (characters / 4) on each code-agent
 * model call that carries it.
 */
export const MAX_ANALYSIS_AGENT_CONTEXT = 4096;

/** Issue #1027 — which plan.md components and tasks.md tasks went as context. */
const specKitHandoffContextSchema = z
  .object({
    components: z.array(z.string().min(1).max(64)).max(SPEC_KIT_HANDOFF_MAX_LABELS),
    tasks: z.array(z.string().min(1).max(64)).max(SPEC_KIT_HANDOFF_MAX_LABELS),
    omitted: z.array(z.string().min(1).max(64)).max(SPEC_KIT_HANDOFF_MAX_LABELS),
    /**
     * The files that were read with no component or task recognised in them, so
     * the analysis page says that instead of "not read". Absent when both
     * files, where present, were recognised.
     */
    unrecognised: z
      .array(z.enum(["plan.md", "tasks.md"]))
      .max(2)
      .optional(),
  })
  .strict();

export const specKitHandoffSchema = z
  .object({
    artifacts: z.array(z.string().min(1).max(200)).max(10),
    sent: z.array(z.string().min(1).max(64)).max(SPEC_KIT_HANDOFF_MAX_LABELS),
    omitted: z.array(z.string().min(1).max(64)).max(SPEC_KIT_HANDOFF_MAX_LABELS),
    /**
     * Issue #1027 — set when plan.md and tasks.md were read for `agentContext`:
     * the components and tasks sent, and those left out for the limit. Absent on
     * a handoff from before #1027, which sent no context.
     */
    context: specKitHandoffContextSchema.optional(),
  })
  .strict();
export type SpecKitHandoffRecord = z.infer<typeof specKitHandoffSchema>;

/**
 * Issue #1027 (review) — the component and task labels of a handoff record that
 * do NOT appear in the context text sent with it. The analysis page shows these
 * labels as "what the code agent was given", and they are written by the
 * caller, so the start route refuses a record that names something the text
 * does not hold (which includes any label at all when no context was sent).
 *
 * This checks the lists one way only: the text may hold more than the labels
 * name, which is why the analysis page also shows the stored text itself. The
 * `omitted` list names what was NOT sent, so nothing can be checked against the
 * text; the page presents it as reported by the client.
 */
export function specKitHandoffLabelsNotInContext(
  handoff: SpecKitHandoffRecord | undefined,
  agentContext: string | undefined,
): string[] {
  const context = handoff?.context;
  if (!context) return [];
  const text = agentContext ?? "";
  return [...context.components, ...context.tasks].filter((label) => !text.includes(label));
}

export const startAnalysisSchema = z.object({
  documentIds: z.array(idSchema).max(100).optional(),
  agentKeys: z.array(z.enum(ANALYSIS_SPECIALIST_AGENT_KEYS)).max(4).optional(),
  model: z.string().min(1).max(120).optional(),
  /**
   * Free-text "new requirements" to evaluate against the current
   * implementation (requirements → code gap analysis). Forwarded to the agent
   * prompt via `escapeContext` (treated as untrusted data, never instructions).
   */
  extraInstructions: z.string().min(1).max(MAX_EXTRA_INSTRUCTIONS).optional(),
  /**
   * Epic #922 — opt-in: perform LLM-driven web research on requirement items
   * that need external evidence. Off by default; no-op when offline / no key.
   */
  enableWebResearch: z.boolean().optional(),
  /**
   * Epic #922 — opt-in: surface clarifying questions for ambiguous
   * requirements so the user can answer and feed the answers back in.
   */
  enableClarification: z.boolean().optional(),
  /**
   * Issue #1006 — start from imported requirements (project-scoped ids). Each
   * becomes one new requirement of the run, in order, and the run records which
   * imported item it was.
   */
  importedRequirementIds: z
    .array(idSchema)
    .min(1)
    .max(MAX_IMPORTED_REQUIREMENTS_PER_ANALYSIS)
    .optional(),
  /** Issue #994 — set by the Spec Kit handoff: what it sent and what it left out. */
  specKitHandoff: specKitHandoffSchema.optional(),
  /**
   * Issue #1027 — background for the code agent, kept apart from the
   * requirements: it is never split into requirements, never counted as one and
   * never used as a search query. Untrusted text; fenced in the prompt like
   * every other data block. Trimmed, so a whitespace-only value is refused like
   * an empty one rather than stored and read three different ways.
   */
  agentContext: z.string().trim().min(1).max(MAX_ANALYSIS_AGENT_CONTEXT).optional(),
});
export type StartAnalysisInput = z.infer<typeof startAnalysisSchema>;

/**
 * Issue #1001 — optional POST body for `/analyses/:id/agents/:agentKey/regenerate`.
 * `extendBudget` continues a code investigation that ran out of budget by
 * re-running the code agent with a larger token budget; only the `code` agent
 * accepts it.
 */
export const regenerateAgentSchema = z
  .object({
    extendBudget: z.boolean().optional(),
  })
  .strict();
export type RegenerateAgentInput = z.infer<typeof regenerateAgentSchema>;

/** PATCH body for an individual requirement (approve / edit / reject). */
export const updateRequirementSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  body: z.string().min(1).max(4096).optional(),
  priority: z.enum(REQUIREMENT_PRIORITIES).optional(),
  type: z.enum(REQUIREMENT_TYPES).optional(),
  labels: z.array(z.string().min(1).max(64)).max(16).optional(),
  storyPoints: z.number().int().min(0).max(100).nullable().optional(),
  reviewStatus: z.enum(REQUIREMENT_REVIEW_STATUSES).optional(),
});
export type UpdateRequirementInput = z.infer<typeof updateRequirementSchema>;

// ---- Finding deep-dive → issue draft (Epic #176 / #178) --------------------

/**
 * Request body for `POST /api/projects/:projectId/analyses/:analysisId/findings/:findingId/deep-dive`.
 *
 * `instructions` is optional free-text steering from the user. It is treated
 * as UNTRUSTED data (never as model instructions) and is length-bounded to
 * keep the single LLM call within the analysis token budget.
 */
export const deepDiveFindingSchema = z.object({
  instructions: z.string().min(1).max(2000).optional(),
});
export type DeepDiveFindingInput = z.infer<typeof deepDiveFindingSchema>;

/**
 * Structured, ready-to-publish issue draft produced by expanding a single
 * analysis finding. The shape mirrors what a GitHub/Jira issue needs: a crisp
 * title, a problem statement, the concrete artifacts it touches, testable
 * acceptance criteria, and suggested labels. The model never returns prose
 * outside this contract — the route validates with `findingIssueDraftSchema`.
 *
 * Distinct from the persisted `issueDraftSchema` in `publishing.ts` (a Prisma
 * row for the batch-publish flow); this is an ephemeral, LLM-produced draft
 * scoped to a single analysis finding.
 */
export const findingIssueDraftSchema = z.object({
  title: z.string().min(1).max(255),
  problemStatement: z.string().min(1).max(8192),
  affected: z
    .object({
      files: z.array(z.string().min(1).max(512)).max(50).default([]),
      requirementIds: z.array(z.string().min(1).max(128)).max(50).default([]),
    })
    .default({ files: [], requirementIds: [] }),
  acceptanceCriteria: z.array(z.string().min(1).max(1024)).max(30).default([]),
  suggestedLabels: z.array(z.string().min(1).max(64)).max(20).default([]),
});
export type FindingIssueDraft = z.infer<typeof findingIssueDraftSchema>;

/**
 * A finding's deep-dive draft serialized into a GitHub-ready issue draft
 * (Issue #744, Epic #728). `title`/`labels` map to `gh issue create --title/--label`;
 * `body` is the sanitized, injection-safe markdown (problem statement, acceptance
 * criteria checklist, affected files, requirement ids). Produced server-side so
 * the escaping is stable — the export never auto-creates the issue, it only
 * yields the paste-ready draft.
 */
export interface FindingIssueDraftExport {
  title: string;
  body: string;
  labels: string[];
}

/** Response envelope for the deep-dive endpoint — draft plus token accounting. */
export const deepDiveResultSchema = z.object({
  draft: findingIssueDraftSchema,
  meta: z.object({
    tokensUsed: z.number().int().min(0),
    model: z.string().min(1).max(120),
  }),
});
export type DeepDiveResult = z.infer<typeof deepDiveResultSchema>;

/**
 * Request body for `POST /api/projects/:projectId/analyses/:analysisId/findings/:findingId/publish`.
 *
 * Publishes a finding (optionally with an edited deep-dive draft) as an issue
 * to the project's configured destination(s). `draft` lets the UI persist the
 * user's edits from the deep-dive dialog before publishing.
 */
export const publishFindingSchema = z
  .object({
    provider: z.enum(["github", "jira"]).optional(),
    draft: findingIssueDraftSchema,
    extraLabels: z.array(z.string().min(1).max(64)).max(20).optional(),
    /**
     * #733 — the GitHub repository to file into. Omitted = the project's
     * configured publish target; with neither, a GitHub publish is refused
     * rather than defaulting to the analysed repo connector's repository.
     */
    target: githubPublishTargetSchema.optional(),
    /**
     * #1180 — set only by the UI's cross-project confirm, after the server
     * refused a GitHub publish with `REPO_CROSS_PROJECT`. Must be a boolean.
     */
    confirmCrossProject: z.boolean().optional(),
  })
  .strict();
export type PublishFindingInput = z.infer<typeof publishFindingSchema>;

/**
 * #289 — the agent a NON-specialist analysis row came from: an enabled custom
 * agent or an explicitly enabled library agent that ran in the analysis agent
 * phase. `name` is the agent's name when the run happened (operator-authored
 * text — render it as text, never as HTML).
 */
export interface AnalysisAgentSource {
  kind: AgentKind;
  ref: AgentRef;
  name: string;
}

/**
 * #289 — `AgentResult.agentKey` on the snapshot: a built-in agent key, or the
 * {@link AgentRef} (`custom:<id>` / `library:<id>`) of an agent-phase agent.
 */
export type AnalysisResultAgentKey = (typeof ANALYSIS_AGENT_KEYS)[number] | AgentRef;

const AGENT_PHASE_KEY_RE = /^(library|custom):[A-Za-z0-9_-]{1,128}$/;

/** #289 — is `key` the persisted agentKey of an agent-phase (custom/library) agent? */
export function isAgentPhaseResultKey(key: unknown): key is AgentRef {
  return typeof key === "string" && AGENT_PHASE_KEY_RE.test(key);
}

/**
 * Issue #1007 — a run's tokens as the project ledger (`token_usages`) has them,
 * the one definition every run surface shows. `withoutCache` is fresh input +
 * output; `withCache` adds cache reads and cache writes, each counted once.
 */
export interface LedgerTokens {
  withCache: number;
  withoutCache: number;
}

/** #977 — an analysis's ledger spend so far; see {@link AnalysisSnapshot.ledgerUsage}. */
export interface AnalysisLedgerUsage {
  totalTokens: number;
  /**
   * #1007 — the same rows as {@link LedgerTokens}, which is what the page
   * shows. Absent when only the totals could be read.
   */
  tokens?: LedgerTokens;
  /** Unrounded USD of the priced calls; `null` when none was priced. */
  costUsd: number | null;
  unpricedTokens: number;
}

/**
 * Issue #766 — an agent running on an analysis right now, as the server
 * process running it sees it. Lets the page show a Regenerate in progress on
 * the agent's card instead of its stale `completed` result.
 */
export interface AnalysisLiveAgent {
  agentKey: string;
  /** ISO time the (re-)run of this agent started. */
  startedAt: string;
  /** Tool calls the agent's investigation has made so far (the code agent's tool loop). */
  toolCalls: number;
  /** True for a Regenerate / Continue of a finished run, false inside a normal run. */
  rerun: boolean;
  /** `synthesizing` once a re-run's agent is done and the run is re-synthesised. */
  phase: "investigating" | "synthesizing";
}

/**
 * Snapshot of an analysis returned by `GET /api/analyses/:id` and pushed over
 * Socket.IO when the run completes.
 */
export interface AnalysisSnapshot {
  id: string;
  projectId: string;
  status: (typeof ANALYSIS_STATUSES)[number];
  startedAt: string;
  completedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * #977 — the run's spend as the project ledger (`token_usages`) has it so
   * far: every model call billed to this analysis's session, read when the
   * snapshot is. `totalTokens` is written only when the run finishes, so a
   * running analysis read "0 tok" throughout; this moves as calls land.
   * `costUsd` is unrounded (`null` = none of it was priced). Absent or `null`
   * when the ledger could not be read.
   */
  ledgerUsage?: AnalysisLedgerUsage | null;
  errorMessage: string | null;
  /**
   * Issue #1143 — the agents whose result failed ({@link analysisFailedAgents}).
   * Non-empty on a `completed` run: it completed with errors.
   */
  failedAgents?: string[];
  /**
   * Issue #1143 — the malformed citations each agent lost, from the capability
   * record. Non-empty on a `completed` run with no failed agent: it completed
   * with warnings.
   */
  droppedCitations?: AnalysisDroppedCitations[];
  /** Issue #766 — agents running right now ({@link AnalysisLiveAgent}); empty when none is. */
  liveAgents?: AnalysisLiveAgent[];
  metadata: Record<string, unknown> | null;
  agents: Array<{
    agentKey: AnalysisResultAgentKey;
    /**
     * #289 — set on rows produced by a custom or library agent in the analysis
     * agent phase, so every finding can be attributed to the agent that made
     * it. Null for the built-in specialists and synthesis.
     */
    source: AnalysisAgentSource | null;
    status: (typeof AGENT_RESULT_STATUSES)[number];
    startedAt: string;
    completedAt: string | null;
    summary: string | null;
    notes: string[];
    findings: Array<{
      id: string;
      category: (typeof FINDING_CATEGORIES)[number];
      severity: (typeof FINDING_SEVERITIES)[number];
      title: string;
      body: string;
      tags: string[];
      citations: SnapshotCitation[];
      /** Epic #298 / #312 — provenance of the finding. */
      derivation: FindingDerivation;
      /** Epic #298 / #312 — agent's self-reported probability in [0,1]. */
      confidence: number;
      /** Epic #298 / #312 — id of the AgentResult that produced the finding. */
      agentResultId: string;
      /**
       * Epic #912 (#916/#920) — id of the requirement this finding traces to
       * (e.g. `REQ-003`), or null when it is a generic observation.
       */
      requirementId?: string | null;
      /**
       * Epic #727 (#740) — deterministic verifier verdict. `confirmed` when the
       * finding kept a grounded code citation, `unverified` when its code claim
       * was dropped by the #734 gate, `ungrounded` (#727) when an agent with no
       * code access wrote it, `null` for findings that made no code
       * claim (or were persisted before #740). Drives the UI verification badge.
       */
      verificationStatus?: FindingVerificationStatus | null;
      /**
       * Issue #773 — the GATED verdict this finding reaches about its
       * requirement. `could-not-verify` means the finding's claim (typically an
       * absence claim) is NOT backed by working retrieval — the UI must render
       * it distinctly from a confirmed gap.
       */
      verdict?: RequirementVerdict | null;
      /**
       * Epic #1107 (#1109) — the multi-lens panel's confidence signal, present
       * only for runs made with `ANALYSIS_LLM_SUPPORT_PANEL` on. A GRADER, not a
       * gate: it never removes a finding. `confidence: "no-signal"` means the
       * panel learned nothing and must be rendered distinctly from `"low"`.
       */
      supportPanel?: FindingSupportPanel | null;
      /**
       * Epic #1316 (#1318) — claim-level faithfulness of the finding against the
       * evidence the run retrieved, on the same [0,1] scale docs-gen reports for
       * its sections. Present only for runs made with
       * `ANALYSIS_FAITHFULNESS_METRIC` on. `score: null` means UNVERIFIABLE and
       * must never be rendered as a bad score.
       */
      faithfulness?: FindingFaithfulness | null;
    }>;
    errorMessage: string | null;
  }>;
  requirements: Array<{
    id: string;
    type: (typeof REQUIREMENT_TYPES)[number];
    title: string;
    body: string;
    priority: (typeof REQUIREMENT_PRIORITIES)[number];
    labels: string[];
    storyPoints: number | null;
    reviewStatus: (typeof REQUIREMENT_REVIEW_STATUSES)[number];
    evidenceFindingIds: string[];
    /**
     * Epic #726 (#736) — deterministic coverage classification. Null for rows
     * whose synthesis predates the field, so the UI renders a neutral state.
     */
    coverage: RequirementCoverage | null;
    /**
     * Issue #773 — deterministic verdict (`implemented` | `gap-confirmed` |
     * `could-not-verify`). Null when the code agent did not run for this
     * analysis, or for rows written before #773.
     */
    verdict: RequirementVerdict | null;
    /**
     * Issue #1096 — the requirement's own testable acceptance criteria, derived
     * at synthesis from its evidence. Empty means none were derived (rendered as
     * an explicit note, never as placeholder criteria).
     */
    acceptanceCriteria: string[];
    /**
     * #990 — true when a user deliberately emptied the list in the Edit dialog.
     * The issue draft then renders no criteria, so the editor must not refill
     * them from the body either. Absent on snapshots that predate the flag.
     */
    acceptanceCriteriaCleared?: boolean;
    /**
     * Epic #34 (AC2) — current optimistic-lock version of the requirement row.
     * Carried on the snapshot so the edit form can submit the version it was
     * rendered with, letting a stale form reliably 409 against concurrent edits.
     */
    version: number;
    /**
     * Epic #1107 (#1110) — the #1109 panel's confidence for this requirement,
     * rolled up from the panels of the findings it was synthesised from, WITH
     * the dissenting lenses' own reasons and `file:line` locators.
     *
     * Derived at read time from data already on this snapshot — no column, no
     * migration — and carried here so the UI can answer *"why is this
     * low-confidence?"* from the response it already has, with no second
     * request and no database round-trip. Null when no linked finding carried a
     * panel, which is every flag-off and every pre-#1109 run.
     */
    supportConfidence: RequirementSupportConfidence | null;
    /**
     * Issue #1063 — the imported items this requirement came from, on a run
     * started from imported items. `[]`: the analysis added it. `null` or
     * absent: not recorded (a run not started from imported items, a row
     * written before #1063, or a synthesis that did not say).
     */
    sourceItems?: AnalysisSourceRequirement[] | null;
    /**
     * Issue #1220 — set when this imported requirement is "diverged from
     * source": the source changed and so did the local copy, so re-sync kept
     * the local text and recorded the source's. Null or absent otherwise.
     */
    sourceDivergence?: RequirementSourceDivergence | null;
    /**
     * Issue #1389 — a re-synthesis (Regenerate or resume) gave this approved
     * requirement different acceptance criteria. The row kept the approved
     * ones; these await the analyst's Accept or Dismiss. Null or absent otherwise.
     */
    criteriaProposal?: RequirementCriteriaProposal | null;
  }>;
  /**
   * Epic #203 (#221) — first-class cross-document conflict / contradiction /
   * completeness findings detected over the ingested customer documents. Null
   * when the detection pass never ran (e.g. offline with no parseable output,
   * or pre-#203 analyses).
   */
  crossDocFindings: CrossDocFindings | null;
  /**
   * Issue #733 (Epic #725) — structured record of which analysis capabilities
   * were available for this run, so the UI can explain (not silently swallow)
   * degraded modes: no code graph, repo source not ingested, agentic code
   * analysis unavailable, disabled grounding flags, quarantine fallback, and
   * repos skipped for budget. Null on runs that predate the capability record.
   */
  capability: AnalysisCapability | null;
  /**
   * Issue #735 (Epic #726) — deterministic requirement→code mapping for the
   * "Evaluate new requirements" free text. Each candidate parsed from the
   * operator's new-requirements input carries the affected code symbols that
   * Impact Analysis's mapper + blast radius matched to it. Null when no new
   * requirements were supplied, the feature is disabled, or no candidates were
   * parsed — so pre-#735 runs (and plain runs) render nothing.
   */
  affectedCode: AnalysisAffectedCode | null;
  /**
   * Issue #739 (Epic #727) — per-requirement escalation policy decision. Scores
   * each extracted requirement for ambiguity + impact (blast-radius size) and
   * routes high scorers to a deeper multi-hop agentic pass. Null when the policy
   * is disabled (the default), the run had no agentic code pass, or no
   * requirements were extracted — so pre-#739 runs render nothing.
   */
  escalation: AnalysisEscalation | null;
  /**
   * Issue #773 — how well the code agent's RETRIEVAL actually worked on this
   * run, and the searched-scope provenance behind every `gap-confirmed` verdict.
   * Null when the run had no agentic code pass (or predates #773).
   */
  retrieval: AnalysisRetrievalHealth | null;
  /**
   * Epic #852 Phase 2b (#855) — the database-aware-analysis resolver's decision
   * for this run, threaded from `resolveDatabaseAwareAnalysis` (#854) so the UI
   * (#859) and e2e (#861) can observe whether schema reasoning ran and WHY,
   * instead of a silent no-op. Null when neither the code nor database agent
   * ran (the resolver was never applicable) or on runs that predate #855.
   */
  databaseAware: AnalysisDatabaseAware | null;
  /**
   * Issue #1006 — the imported requirements this run was started from, each with
   * the `NR-*` id it carried through the run. Absent on runs not started from
   * imported requirements (and on every run before #1006).
   */
  sourceRequirements?: AnalysisSourceRequirement[];
}

// ---- Import re-sync divergence (Issue #1220) --------------------------------

/**
 * Issue #1220 — the source's newer content of an imported requirement that is
 * diverged from it, for the analyst to compare with the local copy and answer
 * with `POST /api/requirements/:id/source-divergence`.
 */
export interface RequirementSourceDivergence {
  /** Sent back with the answer, so a source that moved again is not taken blind. */
  sourceFingerprint: string;
  /** When re-sync first saw this source content. */
  detectedAt: string;
  /**
   * The requirement was edited in METIS before METIS tracked its source, so
   * there is no record of the source at the time of that edit: only that the
   * source now differs. The card words it accordingly.
   */
  baselineUnknown?: boolean;
  source: {
    title: string;
    body: string;
    type: string;
    priority: string;
    labels: string[];
  };
}

/** Issue #1220 — the analyst's last answer to a divergence, shown in History. */
export interface RequirementSourceDecision {
  choice: "source" | "local";
  actorId: string | null;
  at: string;
}

// ---- Re-synthesis criteria proposals (Issue #1389) ---------------------------

/**
 * Issue #1389 — acceptance criteria a re-synthesis suggested for an approved
 * requirement in place of the approved ones, which the row keeps. Answered with
 * `POST /api/requirements/:id/criteria-proposal`.
 */
export interface RequirementCriteriaProposal {
  /** The suggested criteria; `[]` when the re-synthesis gave none. */
  proposed: string[];
  /** When the re-synthesis made the suggestion (ISO). */
  at: string;
}

/** Issue #1389 — body of `POST /api/requirements/:id/criteria-proposal`. */
export const resolveCriteriaProposalSchema = z
  .object({
    choice: z.enum(["accept", "dismiss"]),
    /** The version the card showed; checked when accepting. */
    version: z.number().int().min(0).optional(),
  })
  .strict()
  // Accepting writes a version, so it must say which version it was based on.
  .refine((v) => v.choice !== "accept" || v.version !== undefined, {
    message: "`version` is required to accept",
    path: ["version"],
  });
export type ResolveCriteriaProposalInput = z.infer<typeof resolveCriteriaProposalSchema>;

// ---- Analysis from imported requirements (Issue #1006) ----------------------

/**
 * Issue #1006 — an imported requirement (GitHub / Jira / Azure DevOps / Linear)
 * a run can be started from, as listed by
 * `GET /projects/:projectId/analyses/imported-requirements`.
 */
export interface ImportedRequirementOption {
  id: string;
  title: string;
  type: string;
  externalSource: string;
  externalId: string | null;
  externalUrl: string | null;
}

/** Response of `GET /projects/:projectId/analyses/imported-requirements`. */
export interface ImportedRequirementOptions {
  /** Newest first, at most the server's listing cap, narrowed by `?q=`. */
  items: ImportedRequirementOption[];
  /** How many imported requirements match `?q=` (all of them, without one). */
  total: number;
  /** True when `total` exceeds `items.length`: refine `q` to reach the rest. */
  truncated: boolean;
  /**
   * How many a run analyses individually: the server's new-requirement
   * candidate cap. A larger selection is refused rather than silently cut.
   */
  maxSelectable: number;
}

/**
 * Issue #1006 — the link between an imported requirement and the run it was
 * analysed in. `candidateId` is the `NR-*` id the requirement carried, so the
 * run's findings and requirement-input account can be read back against it.
 */
export interface AnalysisSourceRequirement {
  candidateId: string;
  requirementId: string;
  title: string;
  externalSource: string;
  externalId: string | null;
  externalUrl: string | null;
}

// ---- Database-aware analysis run decision (Epic #852 Phase 2b, #855) --------

/**
 * Machine-readable reason the database-aware resolver arrived at its decision.
 * Structurally mirrors `DbAwareReason` in
 * `server/src/lib/analysis/database-aware-resolver.ts` (#854) — duplicated here
 * rather than imported because `packages/shared` cannot depend on server code;
 * keep the two literal unions in sync.
 */
export type AnalysisDatabaseAwareReason =
  | "off"
  | "auto->resolved-on"
  | "auto->resolved-off-no-data"
  /**
   * #849 — the project is on `auto`, but an operator EXPLICITLY set
   * `ANALYSIS_AFFECTED_SCHEMA_MAPPING` / `ANALYSIS_SCHEMA_IMPACT` to false, so
   * database-aware analysis is disabled platform-wide. Named to match
   * `SQL_LINEAGE_REASONS`' member of the same name.
   */
  | "auto->platform-disabled"
  | "on"
  | "skipped-no-schema-data";

/**
 * The resolved database-aware-analysis decision for one run, persisted on
 * `metadata.databaseAware` (server/src/lib/analysis/analysis-service.ts) and
 * surfaced as a typed field on the GET/create snapshot.
 */
export interface AnalysisDatabaseAware {
  /** The project's `Project.databaseAwareAnalysis` setting the resolver evaluated. */
  setting: DatabaseAwareAnalysisSetting;
  /** Whether database-aware analysis was enabled for this run. */
  enabled: boolean;
  /**
   * Whether it actually ran (crossed impacted code/requirements into the schema
   * graph). Distinct from `enabled`: an explicit `on` project with no schema data
   * is `enabled: true, ran: false` — a hint, never a silent off.
   */
  ran: boolean;
  /** Machine-readable reason; see {@link AnalysisDatabaseAwareReason}. */
  reason: AnalysisDatabaseAwareReason;
}

// ---- Retrieval health / searched scope (Issue #773) -------------------------

/**
 * One retrieval call the code agent actually made — the SEARCHED-SCOPE
 * provenance behind an absence verdict. An absence claim ("this is not in the
 * codebase") is only meaningful relative to what was searched; without this
 * record `gap-confirmed` is judgement-by-vibes.
 *
 * `query` is the model-authored search string, sanitized + truncated server-side
 * (control characters stripped, ≤120 chars). It is displayed as inert text.
 */
export interface SearchedQuery {
  /** Retrieval tool that ran (`search_code_symbols`, `search_code_graph`, …). */
  tool: string;
  /** The search string / filter the agent ran, when the call carried one. */
  query?: string;
  /** True when the call returned usable results (not an error, not empty). */
  hit: boolean;
  /**
   * The call ERRORED (the tool itself failed — bad args, no clone dir, an
   * exception). Absent/false ⇒ the tool WORKED; combined with `hit: false` that
   * means a well-formed EMPTY result, which is evidence ABOUT THE CODEBASE
   * (the thing genuinely was not there for this query) rather than evidence that
   * retrieval is broken. Keeping the two apart is what stops a codebase full of
   * real gaps from being flagged as a degraded run — see `retrieval-health.ts`.
   */
  errored?: boolean;
}

/**
 * Issue #773 — the run's code-retrieval health. This is an INPUT TO THE VERDICT,
 * not merely a banner: the verdict needs two independent signals — (a) did
 * retrieval succeed, (b) does the retrieved evidence show absence — and only
 * (a) && (b) licenses `gap-confirmed`. This carries (a).
 */
export interface AnalysisRetrievalHealth {
  /**
   * CODE-retrieval calls that returned usable, non-empty results.
   *
   * Every counter on this record is measured over the CODE-retrieval tools ONLY
   * (`search_code_graph`, `search_code_symbols`, `read_file_slice`, `list_files`).
   * A `search_knowledge` hit is DOCUMENT RAG: it says nothing about whether the
   * code exists, so letting it count here would launder "no code search worked"
   * into a confirmed code gap — #773 through a different tool.
   */
  successfulSearches: number;
  /** Code-retrieval calls that errored or came back empty (the complement of the above). */
  failedSearches: number;
  /**
   * Code-retrieval calls whose TOOL FAILED (bad args, exception, missing clone dir) —
   * a strict subset of `failedSearches`. This, and NOT `failedSearches`, is what
   * degradation is measured on: a well-formed EMPTY result is what a correct
   * absence investigation returns, so counting empties as brokenness would make a
   * codebase's real gaps inversely correlated with our ability to report them.
   */
  erroredCalls: number;
  /**
   * Code-retrieval calls the agent loop executed across the run. NOT the loop's
   * total tool-call count (that lives on the #774 `ToolCallTelemetry`, which
   * deliberately covers every tool).
   */
  totalCalls: number;
  /** How many requirements the agent was asked to investigate. */
  requirementCount: number;
  /**
   * RETRIEVAL ITSELF FAILED — the pass could not search the codebase at all, so no
   * verdict from it may stand, in either direction.
   *
   * #19 — on the persisted run record, also set when the pass made far fewer code
   * searches than it had requirements (below `MIN_SEARCHES_PER_REQUIREMENT` in
   * `retrieval-health.ts`). That is a report-side judgement applied after the
   * verdicts are gated; it is never fed back into them.
   *
   * #1236 — this used to be set from turn/token exhaustion, which is a DIFFERENT
   * condition (see `exhausted`): a pass whose 14 searches all worked was branded
   * starved purely for running out of turns, and every one of its findings — file
   * paths, line numbers and all — was retitled "Could not verify".
   */
  starved: boolean;
  /**
   * #19 — how many requirements the analysis page shows as `could-not-verify`
   * (the same `deriveRequirementVerdict` roll-up, so a requirement with no code
   * finding counts). Omitted when none. When more than half of `requirementCount`
   * are unverified, the record is `degraded` — even though a single working search
   * clears the verdict threshold, and even when the pass was `exhausted`.
   * Report-side only: set after verdicts are gated, it never changes one.
   */
  unverifiedRequirements?: number;
  /**
   * #1236 — the loop ran out of TURNS or TOKENS. Retrieval worked; the
   * investigation was merely cut short, so the requirements it never reached are
   * unknown (`could-not-verify`) while the ones it did reach and cite keep their
   * verdict. Scoped per-requirement by the per-claim evidence gate, NEVER applied
   * pass-wide — that conflation is the bug this field exists to end.
   */
  exhausted?: boolean;
  /**
   * The pass was seeded with real, retrieved code context (the #729 passive fused
   * symbol seed returned chunks) even if the agent ran no search of its own. That
   * is PROOF THE CODE INDEX IS ALIVE — the same evidence the requirement-grounded
   * single-shot path trusts for a cited `implemented` claim — so it satisfies the
   * run-level "did retrieval physically work?" rule. It is NOT a search, so it
   * never licenses an absence claim (that still needs a query bearing on the
   * requirement).
   */
  seedGrounded?: boolean;
  /**
   * Retrieval was too broken or too thin to support ANY absence claim (fails the
   * evidence threshold — see `server/src/lib/analysis/retrieval-health.ts`).
   * Drives the `code-retrieval-degraded` capability reason. #19 — on the persisted
   * run record, also set when the pass was search-starved or left most of its
   * requirements `could-not-verify` (see `unverifiedRequirements`).
   */
  degraded: boolean;
  /**
   * Bounded searched-scope provenance: what was actually searched, and what hit.
   * DISPLAY/EXPORT ONLY — it is truncated, so no verdict may be gated on it (the
   * per-claim evidence gate reads the complete, in-memory `ClaimEvidenceIndex`
   * instead; see `retrieval-health.ts`).
   */
  searchedScope: SearchedQuery[];
}

// ---- Requirement escalation policy (Issue #739, Epic #727) -----------------

/**
 * Analysis depth a requirement was routed to by the escalation policy.
 *   - `deep`     = a high-ambiguity / high-impact scorer that earned a deeper
 *                  multi-hop agentic pass (higher turn cap).
 *   - `standard` = a normal single-budget pass, as before the policy.
 */
export const ANALYSIS_DEPTHS = ["standard", "deep"] as const;
export type AnalysisDepth = (typeof ANALYSIS_DEPTHS)[number];

/** The escalation scoring + routing decision for a single extracted requirement. */
export interface RequirementEscalation {
  /** The extracted requirement's id (as produced by the document agent). */
  requirementId: string;
  /** Requirement text, truncated for display. */
  text: string;
  /** Deterministic ambiguity sub-score (0–1) from requirement-text heuristics. */
  ambiguityScore: number;
  /** Deterministic impact sub-score (0–1) derived from the blast-radius size. */
  impactScore: number;
  /** Weighted combined score (0–1); `>= threshold` ⇒ eligible for deep routing. */
  score: number;
  /** Number of code symbols the requirement mapped to (the raw impact signal). */
  blastRadiusSize: number;
  /** The depth this requirement was routed to. */
  depth: AnalysisDepth;
}

/**
 * The per-run escalation decision persisted on the analysis
 * (`metadata.escalation`) and surfaced on the GET snapshot. `requirements`
 * carries every scored requirement (both `deep` and `standard`) so the UI can
 * render the depth indicator and the score tooltip.
 */
export interface AnalysisEscalation {
  /** Whether the escalation policy was enabled for this run. */
  enabled: boolean;
  /** The score threshold at/above which a requirement is eligible for deep routing. */
  threshold: number;
  /** The cap on how many requirements could be escalated to deep in this run. */
  maxEscalations: number;
  /** Every scored requirement, most-escalated first (deep before standard, score desc). */
  requirements: RequirementEscalation[];
}

// ---- Deterministic affected-code mapping (Issue #735, Epic #726) -----------

/**
 * A single code symbol Impact Analysis's mapper/blast-radius matched to a new
 * requirement candidate. Mirrors the impact engine's `AffectedSymbolResult`
 * but carries only the fields the analysis UI + prompt need.
 */
export interface AffectedCodeSymbol {
  filePath: string;
  qualifiedName: string;
  startLine: number | null;
  endLine: number | null;
  /** `direct` (mapper hit) vs a blast-radius relation (`caller`/`importer`/`dependency`). */
  relation: ImpactAffectedRelation;
  /** BFS depth from the seed set: 0 = direct, ≥1 = blast radius. */
  depth: number;
  /**
   * 0–1 confidence. Since #1097 it is absolute — an estimate of how often a
   * link like this one is right, the same scale on every requirement — where
   * it used to be relative to the requirement's best link.
   */
  confidence: number;
  /**
   * #1417 — on a `direct` link, the rule that showed THIS link: `confidence`
   * (at least 0.08) or `shared-terms` (the keyword rule). One requirement can
   * mix both (a table beside embedded code). Absent on blast-radius links and
   * on runs before #1417, where the requirement's `linkRule` stands for all.
   */
  linkRule?: "confidence" | "shared-terms";
}

/**
 * #1330 / #1417 — why the keyword rule decided a link the embeddings ranked.
 * `uncalibrated-model`: the embedding model is not one the confidence is
 * calibrated for (every link of the requirement). `schema-not-embedded`: a
 * database table or column, never embedded. `embedding-pending`: code still
 * being embedded; a re-run once embedding finishes can change it.
 * `other-model`: code embedded only with another model, until the project's
 * code is re-embedded with the current one. `not-embedded`: code with no
 * embedding. `no-vector`: no usable embedding, cause not known (every such
 * link of a run recorded before #1417).
 */
export type AffectedCodeKeywordRuleCause =
  | "uncalibrated-model"
  | "schema-not-embedded"
  | "embedding-pending"
  | "other-model"
  | "not-embedded"
  | "no-vector";

/** One discrete requirement parsed from the free-text new-requirements input. */
export interface AffectedCodeCandidate {
  /** Stable, deterministic id (`NR-1`, `NR-2`, …) in parse order. */
  id: string;
  /** Short title (first line / truncated body) of the parsed requirement. */
  title: string;
  /** Full parsed requirement text. */
  body: string;
  /** Affected symbols, most-relevant first. Empty when nothing matched. */
  symbols: AffectedCodeSymbol[];
  /**
   * #1097 — which ranking produced THIS requirement's links, and so which rule
   * decided what is shown. Absent on runs before #1097.
   */
  retrievalMode?: "hybrid" | "bm25-only";
  /**
   * #1330 — the rule that decided which of THIS requirement's links are shown:
   * `confidence` (at least 0.08, the hybrid ranking with a calibrated
   * embedding model) or `shared-terms` (the symbol's name shares two of the
   * requirement's terms: the keyword fallback, and a hybrid ranking with an
   * embedding model the confidence is not calibrated for). Absent on runs
   * before #1330, where the ranking implies it.
   */
  linkRule?: "confidence" | "shared-terms";
  /**
   * #1330 — why the keyword rule (two shared name terms) decided links the
   * embeddings ranked. `uncalibrated-model`: all of them (`linkRule` is
   * `shared-terms`): the embedding model is not one the confidence is
   * calibrated for. `schema-not-embedded`: the links to database tables or
   * columns, which are never embedded (`linkRule` stays `confidence` for the
   * rest). `no-vector`: links to code with no usable embedding (not embedded
   * yet, or embedded with another model). Absent when no link was decided so.
   *
   * Written by #1330 runs only, and worked out before the mapper's floor and
   * top-K; since #1417 a run records {@link keywordRuleCauses} instead. Read
   * for runs saved before it.
   */
  keywordRuleCause?: "uncalibrated-model" | "schema-not-embedded" | "no-vector";
  /**
   * #1417 — every cause behind THIS requirement's SHOWN keyword-rule links
   * (after the mapper's floor and top-K), in a fixed order; plus
   * `uncalibrated-model` whenever the model decided the whole requirement,
   * links or none. Absent when the keyword rule showed nothing for a reason
   * the embeddings could have changed (and on runs before #1417).
   */
  keywordRuleCauses?: AffectedCodeKeywordRuleCause[];
}

/**
 * The per-run deterministic requirement→code mapping surfaced on the analysis
 * snapshot. `candidates` is COMPLETE (never truncated); `truncated` flags only
 * that the prompt block handed to the code agent omitted some entries to stay
 * within its token budget — the persisted/UI list is always full.
 */
export interface AnalysisAffectedCode {
  candidates: AffectedCodeCandidate[];
  truncated: boolean;
  /**
   * #1097 — which ranking mapped the requirements: `hybrid` (keywords fused
   * with the project's symbol embeddings), `bm25-only` (keywords alone: no
   * semantic embedder, or the project's symbols not embedded yet), or `mixed`
   * when some requirements fell back and others did not (each candidate's own
   * `retrievalMode` says which). Absent on runs before #1097.
   */
  retrievalMode?: "hybrid" | "bm25-only" | "mixed";
}

// ---- Traceability matrix (Issue #737, Epic #726) ---------------------------

/**
 * Provenance of a code location in a traceability row.
 *   - `citation` = a finding's CODE citation (`filePath:startLine-endLine`, #734).
 *   - `deterministic-mapping` = a persisted `RequirementCodeMapping` spine row
 *     (Impact Analysis #159 / auto-seeded #207) keyed by the requirement.
 */
export const TRACEABILITY_CODE_SOURCES = ["citation", "deterministic-mapping"] as const;
export type TraceabilityCodeSource = (typeof TRACEABILITY_CODE_SOURCES)[number];

/** A code location a requirement traces to, with its provenance. */
export interface TraceabilityCodeLocation {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  source: TraceabilityCodeSource;
  /** Originating code-graph symbol id, when known (drives test detection). */
  symbolId?: string;
}

/**
 * A test associated with a requirement's mapped code. Since #815 the matrix fills
 * these from the same "Tested by" resolver as the requirement chain (#814).
 */
export interface TraceabilityTestLink {
  filePath: string;
  /** Qualified name of the test symbol, or the file path for a file-only `direct` hit. */
  symbol: string;
  /** How the resolver linked the test (#815). */
  relation?: TestLinkRelation;
}

/** The finding a requirement is grounded in, projected to the matrix columns. */
export interface TraceabilityFindingRef {
  id: string;
  title: string;
  severity: FindingSeverity;
}

/** One row of the traceability matrix: a synthesized requirement and its trace. */
export interface TraceabilityRow {
  requirementId: string;
  title: string;
  /** Coverage classification (#736); null for pre-#736 rows. */
  coverage: RequirementCoverage | null;
  /**
   * Issue #773 — the verdict. Coverage says WHAT evidence exists; the verdict
   * says whether this requirement is implemented, a confirmed gap, or simply
   * could not be verified. A `no_evidence` coverage row must NOT be read as a
   * gap — check the verdict.
   */
  verdict: RequirementVerdict | null;
  findings: TraceabilityFindingRef[];
  codeLocations: TraceabilityCodeLocation[];
  tests: TraceabilityTestLink[];
}

/**
 * The requirement→findings→code→tests traceability matrix for one analysis,
 * assembled entirely from already-persisted rows (requirements, their linked
 * findings, finding code citations, the requirement→code spine) plus a
 * best-effort code-graph test-detection pass. `testsDetection` flags that the
 * tests column is heuristic (path + edge based), never an authoritative link.
 */
export interface TraceabilityMatrix {
  analysisId: string;
  projectId: string;
  rows: TraceabilityRow[];
  testsDetection: "heuristic";
}

// ---- Per-requirement gap report (Issue #742, Epic #728) --------------------

/**
 * A finding a requirement traces to, projected into the gap-report shape. The
 * code agent's gap-path finding `body` already states (1) what the requirement
 * asks, (2) what the current code does/lacks, and (3) the specific change needed
 * (see the `code` specialist prompt in `prompts.ts`) — so it IS the gap
 * narrative; the gap report surfaces it verbatim rather than re-deriving text.
 */
export interface GapReportFindingRef {
  id: string;
  title: string;
  /** The agent-authored gap narrative (current code + gap + change). */
  body: string;
  severity: FindingSeverity;
  /** #740 verifier verdict; `confirmed` findings are the strongest evidence. */
  verificationStatus: FindingVerificationStatus | null;
  /**
   * Issue #773 — the finding's GATED verdict. `could-not-verify` findings are
   * NOT gaps and must be rendered in a visually + semantically distinct block.
   */
  verdict: RequirementVerdict | null;
  /** This finding's CODE citations only (`filePath:startLine-endLine`, #734). */
  citations: CodeCitation[];
}

/**
 * The "current implementation" side of a requirement's gap report: a purely
 * deterministic, code-grounded projection of what exists today. `citations` is
 * the deduped set of CODE citations across the requirement's linked findings
 * (confirmed-first). `hasEvidence` is false when NO linked finding cites code —
 * the UI then renders an explicit no-evidence marker instead of a fabricated
 * summary (no-fabrication rule; mirrors #736 `no_evidence` coverage).
 */
export interface GapReportCurrentImplementation {
  hasEvidence: boolean;
  /** Deduped code citations across the requirement's linked findings. */
  citations: CodeCitation[];
  /** How many linked findings carried at least one code citation. */
  citedFindingCount: number;
}

// ---- Gap report database changes (Epic #820 Phase 1, #825) -----------------

/**
 * Breaking-change classification for an affected database object. Populated by
 * 3a (#830, {@link classifyDdlRisk}) / 3b (#831); a change with no `riskClass`
 * still renders as "unclassified" in the UI / export — the field is deliberately
 * OPTIONAL (absent, not a fabricated "neutral") so a downstream reader never
 * mistakes "not yet classified" for "assessed as safe".
 *
 * This is the SAME triage vocabulary as {@link DdlRiskClass}; it is aliased to
 * the canonical {@link DDL_RISK_CLASSES} (single source of truth — no parallel
 * enum) so the classifier's output type is structurally identical to this field.
 */
export const GAP_REPORT_RISK_CLASSES = DDL_RISK_CLASSES;
export type GapReportRiskClass = (typeof GAP_REPORT_RISK_CLASSES)[number];

/** How a sibling project touches a shared affected object (mirrors 1b / #822). */
export const GAP_REPORT_CONSUMER_USAGES = ["readBy", "writtenBy"] as const;
export type GapReportConsumerUsage = (typeof GAP_REPORT_CONSUMER_USAGES)[number];

/**
 * One cross-project (shared-database) consumer of an affected object — a sibling
 * project in the analyzed project's workspace that reads or writes it (1b /
 * #822). Present ONLY on a change whose `identityResolved` is true; an
 * unresolved change carries no `consumers` at all so "0 consumers" can never be
 * confused with "identity unknown".
 */
export const gapReportSchemaConsumerSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  usage: z.enum(GAP_REPORT_CONSUMER_USAGES),
  /** Schema-qualified identity of the object as this consumer references it. */
  objectQualifiedName: z.string(),
});
export type GapReportSchemaConsumer = z.infer<typeof gapReportSchemaConsumerSchema>;

/**
 * One affected table/column in a requirement's gap report — the DATABASE replay
 * of a code-side gap finding (Epic #820 Phase 1, #825). Assembled from the
 * schema-impact rows (1c / #823) joined with the cross-project consumer
 * enumeration (1b / #822); it invents no new machinery.
 *
 * SAFETY: `suggestedDdl` is TEXT ONLY and is NEVER executed — it originates from
 * the impact engine's `suggestDdl` and is rendered for review behind a mandatory
 * "review only, never executed" label. `identityResolved: false` means the
 * object's cross-project identity could not be resolved: it MUST render as
 * "cross-project impact unknown", never as "no consumers" (a resolved change
 * with an empty `consumers` list is the only thing that legitimately means "no
 * other project uses this").
 */
export const gapReportDatabaseChangeSchema = z.object({
  tableName: z.string(),
  columnName: z.string().nullable(),
  changeKind: z.enum(DDL_CHANGE_KINDS),
  reconciliation: z.enum(SCHEMA_RECONCILIATIONS).nullable(),
  confidence: z.number(),
  suggestedDdl: z.string().nullable(),
  /** Optional until 3a (#830) / 3b (#831) classify risk; absent ⇒ "unclassified". */
  riskClass: z.enum(GAP_REPORT_RISK_CLASSES).optional(),
  /**
   * False when the object's cross-project identity could not be resolved (no
   * workspace, insufficient identity, or an unlinked connection). When false,
   * `consumers` is absent and the object renders as "cross-project impact
   * unknown" — NEVER "no consumers".
   */
  identityResolved: z.boolean(),
  /** Sibling consumers — present ONLY when `identityResolved` is true. */
  consumers: z.array(gapReportSchemaConsumerSchema).optional(),
  /**
   * 3b (#831) — cross-project breaking-change escalation. `true` ONLY when this
   * change is `riskClass: "breaking"` AND its cross-project identity is resolved
   * (`identityResolved: true`) AND at least one sibling project reads or writes
   * the object (`consumers.length >= 1`). Such a change is the CRITICAL case: a
   * contract-breaking DDL on a shared object that other projects demonstrably
   * depend on — grounded in the ENUMERATED consumers (1b / #822), never guessed.
   *
   * Deliberately OPTIONAL and only present when `true`: an ordinary change omits
   * it (absent ⇒ not escalated), so pre-#831 reports round-trip unchanged and a
   * reader never mistakes a missing flag for a fabricated "false". It is NEVER
   * set on an identity-unresolved change (that stays "could-not-verify", per the
   * #773 discipline #826 enforces) — escalation requires confirmed consumers.
   */
  crossProjectBreaking: z.boolean().optional(),
});
export type GapReportDatabaseChange = z.infer<typeof gapReportDatabaseChangeSchema>;

/**
 * One requirement's gap report, assembled ENTIRELY from already-persisted rows
 * (the synthesized requirement + its linked findings + their #734 code
 * citations + #736 coverage + #740 verification). No LLM call and no recompute:
 * the effort estimate is the requirement's existing `storyPoints` (null ⇒ the UI
 * shows "unestimated", never a fabricated number).
 */
export interface GapReportRequirement {
  requirementId: string;
  title: string;
  /** What the requirement asks for (the requirement's own body). */
  body: string;
  priority: RequirementPriority;
  /** #736 deterministic coverage classification; null for pre-#736 rows. */
  coverage: RequirementCoverage | null;
  /** Existing effort field (story points). Null ⇒ "unestimated". */
  storyPoints: number | null;
  /**
   * Roll-up verification: `confirmed` if ANY linked finding is confirmed, else
   * `unverified` if any made an (unconfirmed) code claim, else `ungrounded` if
   * any came from a no-code-access agent (#727), else null (no claim).
   */
  verificationStatus: FindingVerificationStatus | null;
  /**
   * Issue #773 — the requirement's verdict, rolled up from its linked CODE
   * findings' gated verdicts. THE field the UI must lead with: only
   * `gap-confirmed` licenses "build this". `could-not-verify` means the analysis
   * does not know — it must never be rendered as a gap.
   */
  verdict: RequirementVerdict | null;
  currentImplementation: GapReportCurrentImplementation;
  /**
   * The gap analysis — the requirement's linked gap-path findings whose verdict
   * is NOT `could-not-verify`. These are the findings that may legitimately be
   * read as gaps.
   */
  gapFindings: GapReportFindingRef[];
  /**
   * Issue #773 — findings whose claim could NOT be verified (retrieval failed /
   * returned nothing / the investigation never reached this requirement). Split
   * out of `gapFindings` so a "we couldn't check" narrative can never be
   * rendered — or exported — as a confirmed gap.
   */
  unverifiedFindings: GapReportFindingRef[];
  /**
   * Explicit no-evidence marker: true when the requirement has NO linked finding
   * with code evidence. Distinct from `currentImplementation.hasEvidence` only in
   * intent — it is the schema-enforced "nothing found in code" state the UI must
   * render honestly rather than hallucinating a current-implementation summary.
   */
  noEvidence: boolean;
  /**
   * Issue #825 — the affected database objects for this requirement (the DATABASE
   * replay of `gapFindings`): the schema-impact rows (1c / #823) joined with the
   * cross-project consumers (1b / #822). ABSENT (undefined) when the requirement
   * has no schema impact — the section is omitted rather than scaffolded empty,
   * and reports persisted before this change (no `databaseChanges`) round-trip
   * unchanged.
   */
  databaseChanges?: GapReportDatabaseChange[];
}

/**
 * The per-requirement gap report for one analysis, assembled from persisted data
 * (Issue #742). Reusable by the D3 export (#744) the same way the traceability
 * matrix service (#737) feeds its CSV/markdown serializers.
 */
export interface GapReport {
  analysisId: string;
  projectId: string;
  requirements: GapReportRequirement[];
  /**
   * Issue #773 — the run's code-retrieval health + searched-scope provenance.
   * Every `gap-confirmed` verdict in this report is an absence claim relative to
   * THIS searched scope; the UI surfaces it so a gap is auditable rather than
   * taken on faith. Null for runs with no agentic code pass (or pre-#773 runs).
   */
  retrieval: AnalysisRetrievalHealth | null;
  /**
   * Issue #856 (Epic #852 Phase 2c) — the SAME database-aware-analysis resolver
   * decision (#854) that gates the run path's schema reasoning (`metadata.
   * databaseAware`, #855), now also threaded through the gap-report path so a
   * user looking at an empty `databaseChanges` section can see WHY (e.g.
   * `skipped-no-schema-data`) instead of a silent no-op. Optional (rather than
   * `| null` like `retrieval`) so the many pre-#856 `GapReport` test fixtures
   * across the codebase keep compiling unmodified; a report assembled without a
   * resolved decision (e.g. `getGapReport(id)` with no deps) simply omits it.
   */
  databaseAware?: AnalysisDatabaseAware | null;
  /**
   * Issue #895 (Epic #882 Phase 3) — resolved vs unresolved/dynamic schema-edge
   * coverage for the project's schema graph as a whole (NOT per-requirement —
   * it reflects everything the ingest pipeline has ever written, independent
   * of which requirement a given edge happens to relate to). `null` when the
   * project's schema graph has no relevant edges yet. Optional (rather than
   * `| null` like `retrieval`) so pre-#895 `GapReport` test fixtures keep
   * compiling; a report assembled without the resolver simply omits it.
   */
  sqlLineageCoverage?: SqlLineageCoverage | null;
}

// ---- SQL-lineage unresolved/dynamic coverage (Issue #895, Epic #882) ------

/**
 * One schema-graph edge the ingest pipeline could NOT resolve precisely —
 * either a dynamic/unresolved reference (MyBatis `${}` #886, PL/SQL
 * `EXECUTE IMMEDIATE`/unrecoverable `MERGE` #892/#893, carrying
 * `schema-graph.ts`'s `UnresolvedRefMetadata` marker) or a coarse Tier-1
 * catalog-dependency edge (`source: "catalog-deps"`, #890 — object-level only,
 * direction unknown). `reason` distinguishes the two so the UI can explain
 * WHY an edge needs manual confirmation. There is no in-app file viewer
 * (see `CodeCitation`), so `filePath` is rendered as a copyable locator, not
 * a link — the same convention every other code reference in METIS follows.
 */
export interface SqlLineageUnresolvedRef {
  edgeId: string;
  kind: SchemaEdgeKind;
  source: SchemaSource;
  reason: "dynamic" | "coarse-catalog";
  filePath: string;
  /** The referenced object's qualified name (denormalized on `CodeEdge`), when known. */
  toQualifiedName: string | null;
  /** The raw dynamic expression text (`${}`-style refs only). */
  placeholder: string | null;
  /** The mapper statement / call-site id the reference occurred in (`${}`-style refs only). */
  statementId: string | null;
  /** The mapper/class FQCN the statement belongs to, when known (`${}`-style refs only). */
  mapper: string | null;
}

/**
 * Resolved-vs-unresolved schema-edge coverage for one project — Issue #895.
 * `coveragePercent` is `resolvedEdges / totalEdges * 100` (one decimal),
 * `null` when `totalEdges` is 0 (nothing to divide). `bySource` breaks the
 * same counts down by `SchemaSource` provenance (MyBatis/sqlglot/catalog-deps/
 * …) — a proxy for the "per language/framework" breakdown the acceptance
 * criteria calls out as optional, grounded in the taxonomy the schema graph
 * already tracks rather than inventing a parallel language dimension.
 * `unresolvedRefs` is capped (`SQL_LINEAGE_COVERAGE_MAX_REFS`) for payload
 * size — `unresolvedEdges` is always the FULL count, never truncated.
 */
export interface SqlLineageCoverage {
  totalEdges: number;
  resolvedEdges: number;
  unresolvedEdges: number;
  coveragePercent: number | null;
  bySource: Record<string, { total: number; unresolved: number }>;
  unresolvedRefs: SqlLineageUnresolvedRef[];
}

/** Display cap on {@link SqlLineageCoverage.unresolvedRefs} — see its doc comment. */
export const SQL_LINEAGE_COVERAGE_MAX_REFS = 200;

// ---- Requirement diff (Issue #743, Epic #728) ------------------------------

/**
 * A requirement's change classification, mirroring the Change Analysis engine's
 * own `changeType` vocabulary (added / removed / modified). D2 composes that
 * engine's diffing primitives rather than re-deriving them.
 */
export type RequirementDiffChangeType = "added" | "removed" | "modified";

/** Change severity — same scale the Change Analysis engine computes. */
export type RequirementDiffSeverity = "critical" | "high" | "medium" | "low";

/**
 * The "current" (base run) side of a requirement diff: the base requirement as
 * it stood, plus the code-grounded evidence of what exists today. The code
 * citations are the base run's gap-report `currentImplementation.citations` for
 * this requirement (#742 / #734) — never a fabricated summary. Null on the
 * proposed-only `added` case.
 */
export interface RequirementDiffCurrent {
  requirementId: string;
  title: string;
  body: string;
  priority: RequirementPriority;
  storyPoints: number | null;
  /** Current-implementation code evidence (base gap report, #734/#742). */
  codeCitations: CodeCitation[];
  /** False when nothing in code was linked — the UI renders a no-evidence note. */
  hasEvidence: boolean;
}

/**
 * The "proposed" (head run) side of a requirement diff: the head requirement
 * text plus the head run's gap report for it — i.e. what would change and the
 * gap that remains. Null on the current-only `removed` case.
 */
export interface RequirementDiffProposed {
  requirementId: string;
  title: string;
  body: string;
  priority: RequirementPriority;
  storyPoints: number | null;
  /** The head run's gap report for this requirement, or null when unavailable. */
  gapReport: GapReportRequirement | null;
}

/**
 * One changed requirement rendered as current-vs-proposed. `current` is present
 * for `modified` + `removed`; `proposed` is present for `modified` + `added`.
 * `severity` / `impactScore` / `diffSummary` are produced by the Change Analysis
 * engine's own exported scorers (`computeSeverity`, `computeImpactScore`,
 * `generateDiffSummary`) — D2 does not reimplement them.
 */
export interface RequirementDiffEntry {
  changeType: RequirementDiffChangeType;
  severity: RequirementDiffSeverity;
  impactScore: number;
  diffSummary: string;
  current: RequirementDiffCurrent | null;
  proposed: RequirementDiffProposed | null;
}

/**
 * The diff-style current-vs-proposed view for the requirements that CHANGED
 * between a base and a head analysis run (Issue #743). Only real changes appear
 * in `entries`; an unchanged requirement is excluded. When there is no base run
 * to compare against, `baseAnalysisId` is null and `entries` is empty — the UI
 * then shows an explicit empty state rather than treating everything as new.
 */
export interface RequirementDiff {
  projectId: string;
  headAnalysisId: string;
  baseAnalysisId: string | null;
  entries: RequirementDiffEntry[];
  summary: {
    total: number;
    added: number;
    removed: number;
    modified: number;
  };
}

// ---- Analysis capability (Issue #733, Epic #725) ---------------------------

/**
 * Execution mode chosen for the code agent (mirrors the server-side
 * `AgentMode`). `agentic` = code graph + requirements; `requirement-grounded`
 * = requirements but no graph; `single-shot` = no requirements extracted.
 */
export const ANALYSIS_AGENT_MODES = ["single-shot", "agentic", "requirement-grounded"] as const;
export type AnalysisAgentMode = (typeof ANALYSIS_AGENT_MODES)[number];

/**
 * Enumerated, machine-readable degradation reasons. The UI maps each to plain,
 * actionable copy — reasons are never free text so the mapping is exhaustive
 * and testable.
 */
export const ANALYSIS_CAPABILITY_REASONS = [
  "no-code-graph",
  "source-not-ingested",
  "agentic-unavailable-no-requirements",
  "fused-code-retrieval-disabled",
  "schema-context-disabled",
  "quarantine-fallback-used",
  "repos-skipped-budget",
  /**
   * #769/#770 — the code agent RAN and threw (its persisted `agent_results`
   * status is `failed`), so the run carries no code evidence at all. Distinct
   * from the "code analysis was never attempted" reasons above: the user had a
   * code graph and expected code grounding, and got none.
   */
  "code-agent-failed",
  /**
   * #769 — the code agent ran, investigated, but could not serialize a complete
   * JSON answer (turn/token budget exhausted, or prose instead of JSON, even
   * after the bounded final-answer retry). Its findings are partial or empty.
   */
  "code-agent-degraded",
  /**
   * #768 — the operator supplied free-text new requirements, but none of them
   * could be parsed into requirement candidates, so the code agent still fell
   * back to the static single-shot path. Distinct from
   * `agentic-unavailable-no-requirements` (the documents carried no requirements
   * AND the operator supplied none): here the user DID ask for something and it
   * was not analysed against code, so the copy must say how to fix the input.
   */
  "new-requirements-not-analyzed",
  /**
   * Issue #773 — the code agent RAN, COMPLETED, and emitted a valid JSON answer,
   * but its retrieval did not work: tool calls errored, came back empty, or the
   * investigation was cut short before it could cover the requirements. Neither
   * `code-agent-failed` (#770) nor `code-agent-degraded` (#769) fires for this —
   * that is exactly why the #773 incident run reported `reasons: []` while
   * telling the user to rebuild code it already had. Any "not found" result on
   * such a run is unreliable and is labelled `could-not-verify`, never a gap.
   */
  "code-retrieval-degraded",
  /**
   * Issue #777 — the project has a repo CONNECTOR, but no working tree on disk, so
   * the code agent investigated via the code graph + symbol index ALONE (it could not
   * open files). A project can legitimately be fully indexed yet clone-less: the clone
   * was reaped after ingest, the worker disk is ephemeral, the instance was redeployed,
   * or the pipeline is ingest-only.
   *
   * DELIBERATELY DISTINCT from `code-retrieval-degraded`: this is a KNOWN CAPABILITY
   * LIMIT (reduced investigation DEPTH), not a signal that search misbehaved. Before
   * #777 the missing clone made every file-tool call fail, which blew past the tool
   * error-rate threshold and mislabelled the run as retrieval-degraded — telling the
   * user to distrust verdicts that were, in fact, soundly grounded in the graph.
   */
  "repo-clone-unavailable",
  /**
   * Issue #1112 (Epic #1107) — INPUT-side coverage. At least one requirement the
   * user typed into "Evaluate new requirements" never reached the agents: it was
   * sliced off by the candidate cap, was unparseable, or the paste itself was
   * truncated at the 4,096-character input limit.
   *
   * This is the #1101 class of failure and the reason it is a capability reason
   * at all: a run that discarded user input must NOT report unqualified success.
   * Deliberately NOT gated behind `codeAnalysisRequested` — the loss is of the
   * user's own words, and is real whichever agents happened to be selected.
   *
   * A DUPLICATE that was folded into another requirement is NOT this reason:
   * merging is a legitimate, accounted-for outcome (the survivor is named in
   * {@link RequirementInputAccount.merged}), and firing a degradation banner for
   * it would train users to ignore the banner.
   */
  "requirement-inputs-dropped",
  /**
   * Issue #1001 — the agentic code pass ran out of its turn/token budget before it
   * reached every requirement, so the requirements it never searched for came back
   * `could-not-verify` and carry no code link. Distinct from
   * `code-retrieval-degraded` (search misbehaved): here search worked and simply
   * ran out of room. The UI offers to continue the code agent with a larger budget.
   */
  "code-investigation-cut-short",
  /**
   * Issue #1143 — an agent wrote citations that matched no citation shape even
   * after repair, so they were dropped and the findings kept without them.
   * {@link AnalysisCapability.droppedCitations} names each agent and the count.
   * Outside every agent gate: any agent can write one.
   */
  "citations-dropped",
] as const;
export type AnalysisCapabilityReason = (typeof ANALYSIS_CAPABILITY_REASONS)[number];

/**
 * Issue #1112 — why a requirement the user supplied never reached the agents.
 *
 * `candidate-cap`  — sliced off by `ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES`.
 * `unparseable`    — the block held no requirement text once trimmed.
 */
export const REQUIREMENT_INPUT_DROP_REASONS = ["candidate-cap", "unparseable"] as const;
export type RequirementInputDropReason = (typeof REQUIREMENT_INPUT_DROP_REASONS)[number];

/** Max characters of a requirement kept in the account, so the user can recognise it. */
export const REQUIREMENT_INPUT_EXCERPT_MAX = 160;

/** A user-supplied requirement that never reached the agents, and why (#1112). */
export interface DroppedRequirementInput {
  /** The `NR-*` id this input would have carried, in paste order (1-based). */
  id: string;
  /** Recognisable excerpt of what the user wrote (see {@link REQUIREMENT_INPUT_EXCERPT_MAX}). */
  excerpt: string;
  reason: RequirementInputDropReason;
}

/**
 * A user-supplied requirement folded into another requirement as a duplicate
 * (#1112). Distinct from a drop: it WAS accounted for, and the survivor is named
 * — "folded into REQ-003" is fine, "vanished" is not.
 */
export interface MergedRequirementInput {
  id: string;
  excerpt: string;
  /** Id of the requirement that survived and carries this one's intent. */
  mergedIntoId: string;
  /** Excerpt of the survivor, so the user can judge whether the merge was fair. */
  mergedIntoExcerpt: string;
}

/**
 * Issue #1112 (Epic #1107) — input-side coverage for one run.
 *
 * `RequirementCoverage` grades OUTPUTS (does a synthesized requirement have
 * evidence?). This grades INPUTS: every requirement block parsed out of the
 * user's "Evaluate new requirements" paste is accounted for exactly once, as
 * analyzed, merged-into-another, or dropped-with-a-reason. The invariant
 * `parsedCount === analyzedIds.length + merged.length + dropped.length` is what
 * makes "nothing vanished" checkable rather than assumed
 * (see {@link isRequirementInputAccountBalanced}).
 */
export interface RequirementInputAccount {
  /** Requirement blocks parsed out of the paste, BEFORE the candidate cap. */
  parsedCount: number;
  /** Ids that reached the agents as their own requirement. */
  analyzedIds: string[];
  /** Inputs folded into another requirement as duplicates, each naming the survivor. */
  merged: MergedRequirementInput[];
  /** Inputs that never reached the agents, each naming why. */
  dropped: DroppedRequirementInput[];
  /**
   * The submitted text hit the 4,096-character input limit, so the tail of the
   * paste may have been cut before METIS ever saw it. Run-level rather than
   * per-requirement on purpose: the lost text was never parsed, so claiming to
   * know WHICH requirement it was would be a fabrication.
   */
  inputTruncated: boolean;
}

/** Trim requirement text to a recognisable, bounded excerpt for the account. */
export function requirementInputExcerpt(
  text: string,
  max: number = REQUIREMENT_INPUT_EXCERPT_MAX,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** True when every parsed input is accounted for exactly once (the #1112 invariant). */
export function isRequirementInputAccountBalanced(account: RequirementInputAccount): boolean {
  return (
    account.parsedCount ===
    account.analyzedIds.length + account.merged.length + account.dropped.length
  );
}

/**
 * True when the run discarded user input — a drop, or a paste truncated at the
 * input limit. Merges are NOT losses, so they do not count here.
 */
export function hasDiscardedRequirementInputs(
  account: RequirementInputAccount | null | undefined,
): boolean {
  return !!account && (account.dropped.length > 0 || account.inputTruncated);
}

/** A repository skipped from a multi-repo run because the per-repo token budget was too low. */
export interface AnalysisSkippedRepo {
  connectorId: string;
  label: string;
}

/**
 * Structured capability record persisted on the analysis (`metadata.capability`)
 * and surfaced on the GET snapshot + Socket.IO stream. `reasons` is derived from
 * the boolean/mode fields via {@link deriveCapabilityReasons}.
 */
export interface AnalysisCapability {
  /** Whether the code agent (Winston) was part of this run. */
  codeAnalysisRequested: boolean;
  /** Whether the database agent (Sally) was part of this run. */
  databaseAnalysisRequested: boolean;
  /** Whether a built code graph existed for the project at run start. */
  codeGraphPresent: boolean;
  /** The mode the code agent ran in (only meaningful when code analysis was requested). */
  agentMode: AnalysisAgentMode;
  /** Whether repository source was ingested as knowledge (`connector:repo:` documents). */
  repoSourceIngested: boolean;
  /** Whether `ANALYSIS_FUSED_CODE_RETRIEVAL` (#729) was enabled. */
  fusedCodeRetrievalEnabled: boolean;
  /** Whether `ANALYSIS_SCHEMA_CONTEXT` (#732) was enabled. */
  schemaContextEnabled: boolean;
  /** Whether the code agent fell back to raw quarantine chunks for grounding. */
  quarantineFallbackUsed: boolean;
  /** Repos skipped from a multi-repo run for insufficient per-repo token budget (see #741). */
  skippedRepos: AnalysisSkippedRepo[];
  /**
   * #770 — the code agent's persisted result status was `failed`. Optional so
   * capability records persisted before #769/#770 still parse.
   */
  codeAgentFailed?: boolean;
  /**
   * #769 — the code agent completed but could not produce a parseable JSON
   * answer, so its finding set is partial/empty (salvaged from the loop).
   * #1388 — also set when the pass answered but ended shallow: on its own
   * (not budget-cut) with most requirements unverified, or with starved
   * retrieval under half its budget.
   */
  codeAgentDegraded?: boolean;
  /**
   * #1388 — the code agent stopped early on its own with working retrieval, and
   * that is the whole of the run's code-retrieval degradation: the
   * `code-agent-degraded` reason reports it, and #19's coverage-only
   * `code-retrieval-degraded` is not repeated for the same pass.
   */
  codeAgentStoppedEarly?: boolean;
  /**
   * #768 — the operator typed free-text new requirements into the "Evaluate new
   * requirements" box for this run.
   */
  newRequirementsProvided?: boolean;
  /**
   * #768 — those new requirements were parsed into candidates AND fed to a code
   * agent that ran in a non-single-shot mode, i.e. they WERE analysed against
   * code. The positive signal that separates "we found no requirements" from
   * "we analysed the ones you gave us".
   */
  newRequirementsAnalyzed?: boolean;
  /**
   * Issue #773 — the code agent completed, but its retrieval failed the evidence
   * threshold (see `retrieval-health.ts`), so "not found" results on this run are
   * unreliable.
   */
  codeRetrievalDegraded?: boolean;
  /**
   * Issue #777 — a repo connector exists but its clone is not on disk, so the code
   * agent ran WITHOUT file-reading tools (graph + symbol search only). Reduced depth,
   * not broken retrieval.
   */
  repoCloneUnavailable?: boolean;
  /**
   * Issue #1112 — input-side coverage: what became of every requirement the user
   * typed into "Evaluate new requirements". Absent on runs with no free text (and
   * on every run persisted before #1112).
   */
  requirementInputAccount?: RequirementInputAccount;
  /**
   * Issue #1001 — the agentic code pass exhausted its turn/token budget (the run's
   * merged retrieval health is `exhausted`). Optional so records persisted before
   * #1001 still parse.
   */
  codeInvestigationCutShort?: boolean;
  /**
   * Issue #1062 — how many "Continue with a larger budget" reruns of the code
   * agent have finished on this analysis. Absent ⇒ none. Continue is refused once
   * it reaches {@link MAX_CODE_INVESTIGATION_CONTINUATIONS}.
   */
  codeInvestigationContinuations?: number;
  /**
   * Issue #1062 — what the latest code pass left unreached when it too ran out
   * of budget: `unreached` of `total` requirements are `could-not-verify`. Set
   * only while `codeInvestigationCutShort` is true and the pass reported counts.
   */
  codeInvestigationUnreached?: { unreached: number; total: number };
  /**
   * Issue #1143 — the citations each agent wrote that were dropped as malformed.
   * Absent when none were (and on every run persisted before #1143).
   */
  droppedCitations?: AnalysisDroppedCitations[];
  /** Derived, enumerated degradation reasons. Empty ⇒ fully capable run. */
  reasons: AnalysisCapabilityReason[];
}

/**
 * Issue #1062 — how many times one analysis may "Continue with a larger budget".
 *
 * Every continuation reruns the code agent at the SAME enlarged budget (the
 * server's `CONTINUE_BUDGET_MULTIPLIER` × `ANALYSIS_AGENT_TOKEN_BUDGET`), so a
 * second one spends the same tokens to stop in the same place: in #706 run 7 the
 * rerun was cut short again and the button simply stayed. One continuation is
 * therefore the budget ceiling. Raising it means making the multiplier grow per
 * continuation as well — a higher number alone only repeats the run.
 */
export const MAX_CODE_INVESTIGATION_CONTINUATIONS = 1;

/** Issue #1062 — `true` once an analysis has used every continuation it is allowed. */
export function codeInvestigationContinueLimitReached(
  capability: Pick<AnalysisCapability, "codeInvestigationContinuations"> | null | undefined,
): boolean {
  return (capability?.codeInvestigationContinuations ?? 0) >= MAX_CODE_INVESTIGATION_CONTINUATIONS;
}

/**
 * Pre-run, project-level capability facts returned by
 * `GET /projects/:projectId/analyses/capability`. Carries only what is knowable
 * before a run starts (no `agentMode` / quarantine / skipped-repos). The UI
 * combines it with the operator's selected agents to derive the form hint.
 */
export interface AnalysisCapabilityPreview {
  codeGraphPresent: boolean;
  repoSourceIngested: boolean;
  fusedCodeRetrievalEnabled: boolean;
  schemaContextEnabled: boolean;
  /**
   * Issue #938 — the custom and library agents enabled for the project, which
   * every analysis run also invokes. They run PROMPT-ONLY: they get the
   * project's name and description, no documents or code, and none of their
   * tools run (tools apply only when a chat delegates to the agent). Set by the
   * `/analyses/capability` route; absent from the orchestrator's static probe.
   */
  promptOnlyAgents?: AnalysisPromptOnlyAgent[];
}

/** Issue #938 — one enabled agent the analysis run will invoke prompt-only. */
export interface AnalysisPromptOnlyAgent {
  /** `library:<id>` or `custom:<id>`. */
  ref: string;
  kind: "library" | "custom";
  name: string;
  /** The tools the agent declares, none of which run in an analysis run. */
  toolsNotRun: string[];
}

/**
 * Structural input to {@link deriveCapabilityReasons}. A superset of the
 * pre-run preview (which omits `agentMode`, `quarantineFallbackUsed`,
 * `skippedRepos`) and the finalized {@link AnalysisCapability}.
 */
export interface CapabilityReasonInput {
  codeAnalysisRequested: boolean;
  databaseAnalysisRequested: boolean;
  codeGraphPresent: boolean;
  repoSourceIngested: boolean;
  fusedCodeRetrievalEnabled: boolean;
  schemaContextEnabled: boolean;
  /** Omitted pre-run (the mode is only known once requirements are extracted). */
  agentMode?: AnalysisAgentMode | null;
  quarantineFallbackUsed?: boolean;
  skippedRepos?: readonly AnalysisSkippedRepo[];
  /** #770 — the code agent ran and failed outright (persisted status `failed`). */
  codeAgentFailed?: boolean;
  /** #769 — the code agent ran but yielded no parseable JSON answer (partial findings). */
  codeAgentDegraded?: boolean;
  /** #1388 — an early stop is the run's only code-retrieval degradation (see AnalysisCapability). */
  codeAgentStoppedEarly?: boolean;
  /** #768 — the operator supplied free-text new requirements for this run. */
  newRequirementsProvided?: boolean;
  /** #773 — the code agent completed, but its retrieval failed the evidence threshold. */
  codeRetrievalDegraded?: boolean;
  /** #777 — a repo connector exists but its clone is absent, so file tools were withheld. */
  repoCloneUnavailable?: boolean;
  /** #1112 — input-side coverage for the operator's free-text requirements. */
  requirementInputAccount?: RequirementInputAccount | null;
  /** #1001 — the agentic code pass ran out of turn/token budget before covering every requirement. */
  codeInvestigationCutShort?: boolean;
  /** #1143 — citations an agent wrote that were dropped as malformed. */
  droppedCitations?: readonly AnalysisDroppedCitations[];
}

/** Issue #1143 — how many malformed citations one agent's answer lost. */
export interface AnalysisDroppedCitations {
  agentKey: string;
  count: number;
}

/**
 * Issue #1155 — a stored `droppedCitations` value, shape-checked on read. The
 * capability record is a JSON blob, so a value that is not a list (or an entry
 * that is not `{ agentKey, count }`) would otherwise reach the UI's `.filter` /
 * `.some` and throw. Keeps only entries with a non-empty `agentKey` and a
 * positive whole `count`; anything else reads as no drops.
 */
export function readDroppedCitations(value: unknown): AnalysisDroppedCitations[] {
  if (!Array.isArray(value)) return [];
  const out: AnalysisDroppedCitations[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const { agentKey, count } = entry as Record<string, unknown>;
    if (typeof agentKey !== "string" || agentKey.length === 0) continue;
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) continue;
    out.push({ agentKey, count });
  }
  return out;
}

/**
 * PURE derivation of the enumerated degradation reasons from the capability
 * booleans/mode. Shared by the server (persisting the run's reasons) and the UI
 * (pre-run form hint), so the two never drift. Code-analysis reasons are gated
 * behind `codeAnalysisRequested` and schema behind `databaseAnalysisRequested`
 * so a doc-only run never shows code/DB noise.
 */
export function deriveCapabilityReasons(input: CapabilityReasonInput): AnalysisCapabilityReason[] {
  const reasons: AnalysisCapabilityReason[] = [];
  if (input.codeAnalysisRequested) {
    if (!input.codeGraphPresent) reasons.push("no-code-graph");
    if (!input.repoSourceIngested) reasons.push("source-not-ingested");
    // Only assertable once the run picked a mode; pre-run previews omit agentMode.
    // #768 — a single-shot run has two very different causes, and conflating them
    // is a lie: either the DOCUMENTS carried no requirements (and the operator
    // supplied none), or the operator DID supply free-text new requirements that
    // could not be parsed into candidates. Never report the "no requirements"
    // reason for a run the operator explicitly seeded with requirements.
    if (input.agentMode === "single-shot") {
      reasons.push(
        input.newRequirementsProvided
          ? "new-requirements-not-analyzed"
          : "agentic-unavailable-no-requirements",
      );
    }
    if (!input.fusedCodeRetrievalEnabled) reasons.push("fused-code-retrieval-disabled");
    // #770 — the code agent was attempted and DIED. Reported even though the run
    // itself stays `completed` (partial-agent failure is deliberately non-fatal),
    // because the user has a docs-only result that would otherwise look clean.
    if (input.codeAgentFailed) reasons.push("code-agent-failed");
    // #769 — the code agent survived but could not serialize a full answer.
    // Reported independently of `code-agent-failed`: on a multi-repo run one
    // connector can degrade while another throws.
    if (input.codeAgentDegraded) reasons.push("code-agent-degraded");
    // #773 — the code agent completed cleanly and answered in valid JSON, but its
    // SEARCHES did not work. Independent of both flags above (neither fires), and
    // the single most important one to surface: without it the run looks healthy
    // while every "not found" in it is unreliable.
    // #1388 — unless an early stop of the code agent explains it entirely, in
    // which case `code-agent-degraded` above already reports that pass.
    if (
      input.codeRetrievalDegraded &&
      !(input.codeAgentDegraded === true && input.codeAgentStoppedEarly === true)
    ) {
      reasons.push("code-retrieval-degraded");
    }
    // #777 — the repo is indexed but not checked out, so the agent could search the
    // code graph but not open files. Reported on its own, NEVER folded into
    // `code-retrieval-degraded`: the run's verdicts are trustworthy (graph search
    // worked), they are simply shallower. Conflating the two taught the user to
    // discard perfectly good findings.
    if (input.repoCloneUnavailable) reasons.push("repo-clone-unavailable");
    // #1001 — the budget ran out before every requirement was searched for. Those
    // requirements are `could-not-verify` with no code link; the banner offers to
    // continue the code agent with a larger budget.
    if (input.codeInvestigationCutShort) reasons.push("code-investigation-cut-short");
  }
  if (input.databaseAnalysisRequested && !input.schemaContextEnabled) {
    reasons.push("schema-context-disabled");
  }
  if (input.quarantineFallbackUsed) reasons.push("quarantine-fallback-used");
  if (input.skippedRepos && input.skippedRepos.length > 0) reasons.push("repos-skipped-budget");
  // #1112 — OUTSIDE the `codeAnalysisRequested` gate on purpose. The other code
  // reasons describe what the pipeline could not do; this one describes what the
  // USER supplied and we threw away, which is true regardless of agent selection.
  if (hasDiscardedRequirementInputs(input.requirementInputAccount)) {
    reasons.push("requirement-inputs-dropped");
  }
  // #1143 — any agent can write a citation no shape matches; dropping it keeps
  // the findings, and this keeps the loss from being silent.
  if (input.droppedCitations?.some((d) => d.count > 0)) reasons.push("citations-dropped");
  return reasons;
}

/**
 * Issue #1143 — the agents whose result row `failed` in a run, de-duplicated in
 * first-seen order (a multi-repo code agent writes one row per connector). A
 * `cancelled` row is not a failure. Read from the rows rather than from a
 * stored field, so it is right for every run, including ones recorded before
 * this existed.
 */
export function analysisFailedAgents(
  agents: ReadonlyArray<{ agentKey: string; status: string }> | null | undefined,
): string[] {
  const failed: string[] = [];
  for (const a of agents ?? []) {
    if (a.status === "failed" && !failed.includes(a.agentKey)) failed.push(a.agentKey);
  }
  return failed;
}

/** Issue #1143 — the status a completed run in which an agent failed shows. */
export const COMPLETED_WITH_ERRORS_LABEL = "completed with errors";

/**
 * Issue #1143 — the status a completed run shows when no agent failed but an
 * agent's malformed citations were dropped: every agent finished, and some of
 * what one wrote was lost.
 */
export const COMPLETED_WITH_WARNINGS_LABEL = "completed with warnings";

/**
 * Issue #1143 — the status a run shows. A `completed` run in which any agent
 * failed is `completed with errors`; one in which no agent failed but an
 * agent's citations were dropped is `completed with warnings`; anything else
 * shows its stored status. The run stays `completed` in storage because its
 * result is real and usable.
 */
export function analysisStatusLabel(
  status: string,
  failedAgents: readonly string[],
  droppedCitations: readonly AnalysisDroppedCitations[] = [],
): string {
  if (status !== "completed") return status;
  if (failedAgents.length > 0) return COMPLETED_WITH_ERRORS_LABEL;
  if (droppedCitations.some((d) => d.count > 0)) return COMPLETED_WITH_WARNINGS_LABEL;
  return status;
}

/** Whether a capability record represents a degraded run (has ≥1 reason). */
export function isAnalysisDegraded(
  capability: Pick<AnalysisCapability, "reasons"> | null | undefined,
): boolean {
  return !!capability && Array.isArray(capability.reasons) && capability.reasons.length > 0;
}
