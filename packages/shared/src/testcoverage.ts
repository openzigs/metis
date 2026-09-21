/**
 * Test Coverage Gap Analysis (Epic #856) — shared zod schemas + types.
 *
 * These mirror the Prisma models in `server/prisma/schema.prisma` and are
 * imported by both the server (API validation) and the UI (form / list
 * rendering). Keep them in sync with the database whenever the schema moves.
 */
import { z } from "zod";

/** Sources a test case can come from. */
export const TEST_CASE_SOURCES = [
  "excel",
  "csv",
  "docx",
  "markdown",
  "gherkin",
  "jira",
  "xray",
  "zephyr",
  "testrail",
] as const;
export const TestCaseSourceSchema = z.enum(TEST_CASE_SOURCES);
export type TestCaseSource = z.infer<typeof TestCaseSourceSchema>;

export const PrioritySchema = z.enum(["low", "medium", "high", "critical"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const RunStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ImportStatusSchema = z.enum(["pending", "importing", "completed", "failed"]);
export type ImportStatus = z.infer<typeof ImportStatusSchema>;

export const MappingStatusSchema = z.enum(["COVERED", "UNCOVERED", "AMBIGUOUS", "OVERRIDDEN"]);
export type MappingStatus = z.infer<typeof MappingStatusSchema>;

export const SuggestionStatusSchema = z.enum(["draft", "accepted", "rejected", "exported"]);
export type SuggestionStatus = z.infer<typeof SuggestionStatusSchema>;

export const RunModeSchema = z.enum(["A", "B"]);
export type RunMode = z.infer<typeof RunModeSchema>;

/** One step inside a test case. */
export const TestStepSchema = z.object({
  action: z.string().min(1),
  expected: z.string().optional(),
});
export type TestStep = z.infer<typeof TestStepSchema>;

/** Normalised in-memory representation of a test case (pre-persist). */
export const NormalisedTestCaseSchema = z.object({
  externalId: z.string().optional(),
  title: z.string().min(1),
  preconditions: z.string().optional(),
  steps: z.array(TestStepSchema).default([]),
  expected: z.string().optional(),
  priority: PrioritySchema.default("medium"),
  tags: z.array(z.string()).default([]),
  source: TestCaseSourceSchema,
});
export type NormalisedTestCase = z.infer<typeof NormalisedTestCaseSchema>;

/** Persisted TestCaseDoc (DB-shaped). */
export const TestCaseDocSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sourceImportId: z.string(),
  externalId: z.string().nullable(),
  title: z.string(),
  preconditions: z.string().nullable(),
  steps: z.array(TestStepSchema),
  expected: z.string().nullable(),
  priority: PrioritySchema,
  tags: z.array(z.string()),
  source: TestCaseSourceSchema,
  contentHash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestCaseDocDto = z.infer<typeof TestCaseDocSchema>;

export const TestCaseImportSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string().nullable(),
  source: TestCaseSourceSchema,
  status: ImportStatusSchema,
  label: z.string(),
  testCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestCaseImportDto = z.infer<typeof TestCaseImportSchema>;

export const TestCoverageRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  createdById: z.string(),
  status: RunStatusSchema,
  mode: RunModeSchema,
  contentHash: z.string(),
  tokenCostCents: z.number().int().nonnegative(),
  phaseProgress: z.record(z.string(), z.object({ pct: z.number(), ts: z.string() })),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestCoverageRunDto = z.infer<typeof TestCoverageRunSchema>;

export const CoverageMappingSchema = z.object({
  id: z.string(),
  runId: z.string(),
  requirementId: z.string(),
  testCaseDocId: z.string(),
  cosine: z.number(),
  bm25: z.number(),
  fused: z.number(),
  judgeConfidence: z.number().nullable(),
  status: MappingStatusSchema,
  overriddenById: z.string().nullable(),
  overrideReason: z.string().nullable(),
});
export type CoverageMappingDto = z.infer<typeof CoverageMappingSchema>;

export const GapItemSchema = z.object({
  id: z.string(),
  runId: z.string(),
  requirementId: z.string(),
  severity: PrioritySchema,
  meta: z.record(z.string(), z.unknown()),
});
export type GapItemDto = z.infer<typeof GapItemSchema>;

/** Given/When/Then payload for AI-generated suggestions. */
export const GwtSchema = z.object({
  given: z.array(z.string()).default([]),
  when: z.array(z.string()).default([]),
  then: z.array(z.string()).default([]),
});
export type Gwt = z.infer<typeof GwtSchema>;

export const SuggestionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  mappedRequirementIds: z.array(z.string()),
  title: z.string(),
  gwt: GwtSchema,
  steps: z.array(TestStepSchema),
  faithfulness: z.number().min(0).max(1),
  sourceChunks: z.array(
    z.object({
      chunkId: z.string(),
      documentId: z.string().optional(),
      excerpt: z.string().optional(),
    }),
  ),
  status: SuggestionStatusSchema,
  lowConfidence: z.boolean(),
});
export type SuggestionDto = z.infer<typeof SuggestionSchema>;

// ---- Request bodies -------------------------------------------------------

export const CreateRunBodySchema = z.object({
  mode: RunModeSchema.default("A"),
  /// Optional override list of importIds to use for the run (defaults to all
  /// completed imports for the project).
  importIds: z.array(z.string()).optional(),
});
export type CreateRunBody = z.infer<typeof CreateRunBodySchema>;

export const OverrideMappingBodySchema = z.object({
  status: z.enum(["COVERED", "UNCOVERED", "AMBIGUOUS"]),
  reason: z.string().min(1).max(2000),
});
export type OverrideMappingBody = z.infer<typeof OverrideMappingBodySchema>;

export const AcceptSuggestionBodySchema = z.object({
  status: z.enum(["accepted", "rejected"]),
  reason: z.string().max(2000).optional(),
});
export type AcceptSuggestionBody = z.infer<typeof AcceptSuggestionBodySchema>;
