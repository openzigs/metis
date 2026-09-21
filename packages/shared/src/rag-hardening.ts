/**
 * Epic #157 — RAG hardening (v1.1.0).
 *
 * Shared Zod schemas + types for:
 *   - Document quarantine + approval workflow.
 *   - Permission-aware RAG (ACL subjects).
 *   - Chronicle agentic memory.
 *   - RAGAS evaluation results.
 *   - Red-team regression suite results.
 */
import { z } from "zod";

// ── ACL subjects ────────────────────────────────────────────────────────────

export const ACL_SUBJECT_KINDS = ["user", "role", "group"] as const;
export type AclSubjectKind = (typeof ACL_SUBJECT_KINDS)[number];

export const aclSubjectSchema = z.object({
  kind: z.enum(ACL_SUBJECT_KINDS),
  value: z.string().min(1).max(200),
});
export type AclSubject = z.infer<typeof aclSubjectSchema>;

export const aclSubjectsSchema = z.array(aclSubjectSchema).max(64);

export const updateDocumentAclSchema = z.object({
  aclSubjects: aclSubjectsSchema,
});
export type UpdateDocumentAclInput = z.infer<typeof updateDocumentAclSchema>;

// ── Quarantine ──────────────────────────────────────────────────────────────

export const DOCUMENT_INDEX_STATES = [
  "pending",
  "quarantined",
  "reconciling",
  "indexed",
  "rejected",
] as const;
export type DocumentIndexState = (typeof DOCUMENT_INDEX_STATES)[number];

export const quarantineRowSchema = z.object({
  documentId: z.string().min(1),
  filename: z.string(),
  uploadedAt: z.string(),
  chunkCount: z.number().int().min(0),
  indexState: z.enum(DOCUMENT_INDEX_STATES),
  autoApproveTrusted: z.boolean(),
  errorMessage: z.string().nullable().optional(),
});
export type QuarantineRow = z.infer<typeof quarantineRowSchema>;

export const quarantineListResponseSchema = z.object({
  items: z.array(quarantineRowSchema),
  autoApproveTrustedSources: z.boolean(),
});
export type QuarantineListResponse = z.infer<typeof quarantineListResponseSchema>;

export const updateAutoApproveSchema = z.object({
  autoApproveTrusted: z.boolean(),
});

export const updateProjectAutoApproveSchema = z.object({
  autoApproveTrustedSources: z.boolean(),
});

// ── Chronicle ───────────────────────────────────────────────────────────────

export const chronicleEntrySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string().min(1).max(120),
  value: z.string().min(1).max(20_000),
  sourceSessionId: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ChronicleEntryRow = z.infer<typeof chronicleEntrySchema>;

export const recordChronicleEntrySchema = z.object({
  key: z.string().min(1).max(120),
  value: z.string().min(1).max(20_000),
});
export type RecordChronicleEntryInput = z.infer<typeof recordChronicleEntrySchema>;

export const updateChronicleSettingsSchema = z.object({
  chronicleEnabled: z.boolean(),
  chronicleTtlDays: z.number().int().min(1).max(365).optional(),
});

// ── RAGAS ───────────────────────────────────────────────────────────────────

export const ragasMetricKeys = [
  "context_precision",
  "context_recall",
  "faithfulness",
  "answer_relevancy",
] as const;
export type RagasMetricKey = (typeof ragasMetricKeys)[number];

export const ragasScoresSchema = z.object({
  context_precision: z.number().min(0).max(1),
  context_recall: z.number().min(0).max(1),
  faithfulness: z.number().min(0).max(1),
  answer_relevancy: z.number().min(0).max(1),
});
export type RagasScores = z.infer<typeof ragasScoresSchema>;

/**
 * #1317 — one judgement, where a metric may be UNVERIFIABLE.
 *
 * `null` is not a low score and not a high one: it means the judge could not
 * decide, so the metric must be excluded from the mean rather than counted as a
 * pass. The lexical `StubRagasJudge` used to return `1` for every zero-
 * denominator case (an answer with no expected keywords scored a perfect
 * faithfulness by vacuous truth), which moved the aggregate UP in exactly the
 * fixtures the harness understood least. Making the absence representable is
 * what stops that.
 */
export const ragasJudgementSchema = z.object({
  context_precision: z.number().min(0).max(1).nullable(),
  context_recall: z.number().min(0).max(1).nullable(),
  faithfulness: z.number().min(0).max(1).nullable(),
  answer_relevancy: z.number().min(0).max(1).nullable(),
});
export type RagasJudgement = z.infer<typeof ragasJudgementSchema>;

/** Per-metric count of how many fixtures produced a number vs. were unverifiable. */
export const ragasCoverageSchema = z.object({
  context_precision: z.number().int().min(0),
  context_recall: z.number().int().min(0),
  faithfulness: z.number().int().min(0),
  answer_relevancy: z.number().int().min(0),
});
export type RagasCoverage = z.infer<typeof ragasCoverageSchema>;

export const ragasResultSchema = z.object({
  baseline: ragasJudgementSchema.nullable(),
  current: ragasJudgementSchema,
  deltas: ragasJudgementSchema.nullable(),
  regressions: z.array(
    z.object({
      metric: z.enum(ragasMetricKeys),
      baseline: z.number(),
      current: z.number(),
      delta: z.number(),
    }),
  ),
  fixtures: z.number().int().min(0),
  /**
   * #1317 — how many fixtures actually produced a number for each metric, and
   * how many were unverifiable. A mean of 0.95 over 2 of 40 fixtures is a
   * different fact from 0.95 over 40, and without these counts the two are
   * indistinguishable in the committed artifact.
   */
  scored: ragasCoverageSchema.optional(),
  unverifiable: ragasCoverageSchema.optional(),
});
export type RagasResult = z.infer<typeof ragasResultSchema>;

// ── Red team ────────────────────────────────────────────────────────────────

export const redTeamCategories = [
  "prompt_injection",
  "hidden_chars",
  "mcp_poisoning",
  "system_prompt_extraction",
  "role_override",
  "tool_escalation",
] as const;
export type RedTeamCategory = (typeof redTeamCategories)[number];

export const redTeamAttackResultSchema = z.object({
  attack: z.string(),
  category: z.enum(redTeamCategories),
  expected: z.string(),
  observed: z.string(),
  pass: z.boolean(),
});
export type RedTeamAttackResult = z.infer<typeof redTeamAttackResultSchema>;

export const redTeamReportSchema = z.object({
  total: z.number().int().min(0),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  score: z.number().min(0).max(1),
  attacks: z.array(redTeamAttackResultSchema),
  ranAt: z.string(),
});
export type RedTeamReport = z.infer<typeof redTeamReportSchema>;
