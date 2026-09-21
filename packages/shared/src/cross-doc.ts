/**
 * Cross-document conflict / contradiction / gap / completeness detection
 * (Epic #203). These schemas describe the first-class detection output that
 * is persisted onto an `Analysis` and surfaced through the analysis API + UI.
 *
 * Structured output in METIS is produced via JSON-in-prompt + a client-side
 * `parseXxx()` validator (see server `requirements-extractor.ts`). The Zod
 * schemas here are applied **after** `JSON.parse` (never at the model
 * boundary) to give the parsed objects a typed, validated shape.
 */
import { z } from "zod";
import {
  CONTRADICTION_SCOPES,
  CROSS_DOC_FINDING_KINDS,
  FINDING_SEVERITIES,
  NLI_LABELS,
} from "./constants.js";

// ---- NLI contradiction detection (Issue #219) ------------------------------

/**
 * A single NLI statement-pair verdict. `evidenceIds` reference the source
 * segment ids the premise/hypothesis were drawn from (document or chunk ids),
 * so the UI can link a contradiction back to its evidence.
 */
export const nliVerdictSchema = z.object({
  premise: z.string().min(1).max(2000),
  hypothesis: z.string().min(1).max(2000),
  label: z.enum(NLI_LABELS),
  /** Source segment ids (document/chunk ids) supporting the pair. */
  evidenceIds: z.array(z.string().min(1).max(128)).max(50).default([]),
  /** Optional model-reported confidence in [0,1]. */
  confidence: z.number().min(0).max(1).optional(),
  /** `self` = within one document; `pairwise` = across two documents. */
  scope: z.enum(CONTRADICTION_SCOPES).default("pairwise"),
});
export type NliVerdict = z.infer<typeof nliVerdictSchema>;

/** Raw structured output the NLI prompt asks the model to emit. */
export const nliResponseSchema = z.object({
  verdicts: z.array(nliVerdictSchema).max(200).default([]),
});
export type NliResponse = z.infer<typeof nliResponseSchema>;

// ---- Completeness checklist (Issue #220) -----------------------------------

/**
 * A single completeness gap. `kind` identifies which checklist category is
 * missing; `rationale` explains why the corpus is judged to lack it.
 */
export const completenessGapSchema = z.object({
  kind: z.enum([
    "missing-nfr",
    "missing-acceptance-criteria",
    "missing-assumption",
    "missing-risk",
  ]),
  title: z.string().min(1).max(255),
  rationale: z.string().min(1).max(2000),
  /** Source segment ids that informed the judgement (may be empty). */
  evidenceIds: z.array(z.string().min(1).max(128)).max(50).default([]),
});
export type CompletenessGap = z.infer<typeof completenessGapSchema>;

/** Raw structured output the completeness prompt asks the model to emit. */
export const completenessResponseSchema = z.object({
  gaps: z.array(completenessGapSchema).max(100).default([]),
});
export type CompletenessResponse = z.infer<typeof completenessResponseSchema>;

// ---- Persisted / surfaced cross-doc finding (Issue #221) -------------------

/**
 * Issue #448 (epic #407) — a server read-time resolution of a single
 * `evidenceId` (an agent `Finding` row id) into a human-readable source ref.
 *
 * BA/PM-facing surfaces previously rendered each `evidenceId` as a raw opaque
 * cuid chip. The server now resolves the id to its originating document via the
 * `Finding`'s first citation so the UI can render a readable label while still
 * preserving the raw id (`chunkId`) in a tooltip for copy / deep-link and as a
 * graceful-degradation fallback.
 *
 * OWASP / no-leak: only a filename/path basename + line position is surfaced —
 * never the finding body, the citation snippet, a storage path, or any secret.
 */
export const resolvedEvidenceRefSchema = z.object({
  /** The raw `evidenceId` (agent `Finding` row id) — preserved verbatim for
   *  the tooltip, copy, and graceful-degradation fallback. */
  chunkId: z.string().min(1).max(128),
  /** Human-readable source label — a filename/path or documentId. Never a
   *  snippet, body, or storage path. Absent when the finding/citation could
   *  not be resolved. */
  sourceLabel: z.string().min(1).max(255).optional(),
  /** The originating documentId, when resolvable. */
  sourceId: z.string().min(1).max(128).optional(),
  /** The citation `chunkIndex` (position within the source), when available. */
  line: z.number().int().min(0).optional(),
});
export type ResolvedEvidenceRef = z.infer<typeof resolvedEvidenceRefSchema>;

/**
 * A first-class cross-document detection finding as persisted onto the
 * `Analysis` and returned in the analysis snapshot. Both contradictions and
 * completeness gaps normalise into this single shape so the UI can render a
 * unified findings list.
 */
export const crossDocFindingSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(CROSS_DOC_FINDING_KINDS),
  severity: z.enum(FINDING_SEVERITIES),
  title: z.string().min(1).max(255),
  /** Human-readable explanation (contradiction detail or gap rationale). */
  detail: z.string().min(1).max(4000),
  /** Source segment ids (document/chunk ids) referenced as evidence. */
  evidenceIds: z.array(z.string().min(1).max(128)).max(50).default([]),
  /**
   * Issue #448 — server read-time resolution of `evidenceIds` into readable
   * source refs. ADDITIVE and OPTIONAL: legacy/un-enriched payloads omit it and
   * the UI degrades to the raw `evidenceIds`. Only ids that resolve to a
   * citation appear here, so this may be shorter than `evidenceIds`.
   */
  evidence: z.array(resolvedEvidenceRefSchema).max(50).optional(),
  /** For contradictions only — `self` or `pairwise`; null otherwise. */
  scope: z.enum(CONTRADICTION_SCOPES).nullable().default(null),
});
export type CrossDocFinding = z.infer<typeof crossDocFindingSchema>;

/**
 * The bundle of cross-doc findings persisted under `Analysis.metadata`
 * (`crossDocFindings`) and surfaced on the snapshot.
 */
export const crossDocFindingsSchema = z.object({
  findings: z.array(crossDocFindingSchema).max(500).default([]),
  contradictionCount: z.number().int().min(0).default(0),
  completenessGapCount: z.number().int().min(0).default(0),
  /** ISO timestamp the detection pass ran. */
  generatedAt: z.string().min(1).max(64),
});
export type CrossDocFindings = z.infer<typeof crossDocFindingsSchema>;
