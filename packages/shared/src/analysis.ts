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
import type { CrossDocFindings } from "./cross-doc.js";
import type { ImpactAffectedRelation } from "./impact.js";
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
  metadata: z.record(z.unknown()).optional(),
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
  citations: z.array(citationSchema).max(20).default([]),
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
  return (
    `Requirement synthesis was degraded: ${DEGRADATION_CAUSE[reason]}${attemptNote}, ` +
    `so the ${requirementCount} ${count} below were grouped deterministically by keyword ` +
    `overlap instead. Nothing was dropped, but nothing was classified either \u2014 every ` +
    `requirement is typed "feature" and has no acceptance criteria because the fallback ` +
    `cannot derive them. Re-run the analysis to get model-assigned types and criteria.`
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
});
export type StartAnalysisInput = z.infer<typeof startAnalysisSchema>;

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
  })
  .strict();
export type PublishFindingInput = z.infer<typeof publishFindingSchema>;

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
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  agents: Array<{
    agentKey: (typeof ANALYSIS_AGENT_KEYS)[number];
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
      citations: Citation[];
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
       * was dropped by the #734 gate, `null` for findings that made no code
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
   * #1236 — this used to be set from turn/token exhaustion, which is a DIFFERENT
   * condition (see `exhausted`): a pass whose 14 searches all worked was branded
   * starved purely for running out of turns, and every one of its findings — file
   * paths, line numbers and all — was retitled "Could not verify".
   */
  starved: boolean;
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
   * Drives the `code-retrieval-degraded` capability reason.
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
  /** Normalized 0–1 confidence. */
  confidence: number;
}

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

/** A test the code graph associates with a requirement's implicated code. */
export interface TraceabilityTestLink {
  filePath: string;
  /** Qualified name of the test symbol (function/describe) that references the code. */
  symbol: string;
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
   * `unverified` if any made an (unconfirmed) code claim, else null (no claim).
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
   */
  codeAgentDegraded?: boolean;
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
  /** Derived, enumerated degradation reasons. Empty ⇒ fully capable run. */
  reasons: AnalysisCapabilityReason[];
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
  /** #768 — the operator supplied free-text new requirements for this run. */
  newRequirementsProvided?: boolean;
  /** #773 — the code agent completed, but its retrieval failed the evidence threshold. */
  codeRetrievalDegraded?: boolean;
  /** #777 — a repo connector exists but its clone is absent, so file tools were withheld. */
  repoCloneUnavailable?: boolean;
  /** #1112 — input-side coverage for the operator's free-text requirements. */
  requirementInputAccount?: RequirementInputAccount | null;
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
    if (input.codeRetrievalDegraded) reasons.push("code-retrieval-degraded");
    // #777 — the repo is indexed but not checked out, so the agent could search the
    // code graph but not open files. Reported on its own, NEVER folded into
    // `code-retrieval-degraded`: the run's verdicts are trustworthy (graph search
    // worked), they are simply shallower. Conflating the two taught the user to
    // discard perfectly good findings.
    if (input.repoCloneUnavailable) reasons.push("repo-clone-unavailable");
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
  return reasons;
}

/** Whether a capability record represents a degraded run (has ≥1 reason). */
export function isAnalysisDegraded(
  capability: Pick<AnalysisCapability, "reasons"> | null | undefined,
): boolean {
  return !!capability && Array.isArray(capability.reasons) && capability.reasons.length > 0;
}
