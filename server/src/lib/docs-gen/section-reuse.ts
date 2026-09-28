import { createHash } from "node:crypto";
import { z } from "zod";
import type { FaithfulnessResult } from "./grounding/citation-validator.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const inputHashesSchema = z
  .object({
    facts: hashSchema,
    formulas: hashSchema,
    flow: hashSchema,
    grounding: hashSchema,
    context: hashSchema,
    config: hashSchema,
    prompts: hashSchema,
  })
  .strict();
export type SectionInputHashes = z.infer<typeof inputHashesSchema>;

const warningSchema = z
  .object({
    kind: z.enum([
      "section-failed",
      "section-ungrounded",
      "no-modules",
      "source-unavailable",
      "facts-truncated",
      "section-truncated",
      "section-missing",
      "grounding-skipped",
      "grounding-sampled",
      "grounding-failed",
    ]),
    section: z.string(),
    message: z.string(),
    severity: z.enum(["warning", "error"]),
    ratio: z.number().optional(),
    threshold: z.number().optional(),
    domainContext: z.boolean().optional(),
    tier: z.enum(["narrative", "reconstruction", "literal"]).optional(),
    sampled: z.boolean().optional(),
  })
  .strict();

export const sectionEvidenceSchema = z
  .object({
    sourceId: z.string().min(1),
    kind: z.enum(["rag", "web", "facts"]),
    label: z.string().min(1),
    evidenceClass: z.enum(["repository-source", "project-reference", "web-reference"]).nullable(),
    documentId: z.string().min(1).optional(),
    chunkId: z.string().min(1).optional(),
    repository: z
      .object({ codeGraphId: z.string().min(1), repoConnectorId: z.string().min(1).nullable() })
      .strict()
      .optional(),
    filePath: z.string().min(1).optional(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    contentHash: z.string().min(1),
  })
  .strict();

const outputSchema = z
  .object({
    markdown: z.string().min(1),
    warnings: z.array(warningSchema),
    score: z
      .object({
        faithfulness: z.number().min(0).max(1),
        threshold: z.number().min(0).max(1),
        result: z.custom<FaithfulnessResult>(),
      })
      .nullable(),
    metadata: z
      .object({
        sectionLabel: z.string().min(1),
        sectionIndex: z.number().int().min(0),
        providerKind: z.enum(["bedrock", "local", "anthropic"]),
        model: z.string().min(1),
        factsSourceIds: z.array(z.string().min(1)),
        groundingSourceIds: z.array(z.string().min(1)),
      })
      .strict(),
    evidence: z.array(sectionEvidenceSchema),
  })
  .strict();

const sectionRecordSchema = outputSchema
  .extend({
    sectionId: z.string().min(1),
    inputs: inputHashesSchema,
    outputHash: hashSchema,
  })
  .strict();
export type SectionSynthesisRecord = z.infer<typeof sectionRecordSchema>;

/** Version the complete synthesis/grounding contract, not citation coverage.
 * Bump when prompt, refinement, cleanup, claim extraction or judging semantics change.
 * A bump is safe: a stored manifest holding an older snapshot still parses
 * (`storedSectionSynthesisSchema`), and only a current-version snapshot is reused.
 * 2 — #152: claim extraction is batched and a reply cut off at the output cap is
 * no longer retried or parsed, so a section left unverified by a truncated claim
 * list under version 1 must be re-checked, not reused with its stale warning.
 * 3 — #246/#262: a section whose fact-check THREW was stored under version 2 with
 * no score and no warning, indistinguishable from a verified one. A version-2
 * snapshot cannot say whether it was written before or after that fix, so none
 * is reused: each is written and fact-checked afresh once. */
export const SECTION_SYNTHESIS_VERSION = 3;
export const sectionSynthesisSchema = z
  .object({
    version: z.literal(SECTION_SYNTHESIS_VERSION),
    complete: z.literal(true),
    records: z.array(sectionRecordSchema).min(1),
  })
  .strict();
export type SectionSynthesis = z.infer<typeof sectionSynthesisSchema>;

/**
 * A snapshot written under any OTHER contract version. It is kept in the
 * manifest exactly as stored (it is part of that version's history) but is never
 * reused: `reusableSectionRecords` accepts only `sectionSynthesisSchema`. A
 * snapshot that claims the current version must match the current schema.
 */
const otherVersionSectionSynthesisSchema = z
  .object({
    version: z
      .number()
      .int()
      .positive()
      .refine((version) => version !== SECTION_SYNTHESIS_VERSION),
  })
  .passthrough();
export const storedSectionSynthesisSchema = z.union([
  sectionSynthesisSchema,
  otherVersionSectionSynthesisSchema,
]);
export type StoredSectionSynthesis = z.infer<typeof storedSectionSynthesisSchema>;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash the actual ordered prompt dependencies; never persist source text. */
export function hashSectionInputs(
  input: Record<keyof SectionInputHashes, string>,
): SectionInputHashes {
  return inputHashesSchema.parse(
    Object.fromEntries(Object.entries(input).map(([key, value]) => [key, hash(value)])),
  );
}

/** Zod makes a deep copy so subsequent caller mutations cannot alter the record. */
export function recordSectionSynthesis(
  sectionId: string,
  inputs: SectionInputHashes,
  output: z.infer<typeof outputSchema>,
): SectionSynthesisRecord {
  const saved = outputSchema.parse(output);
  return sectionRecordSchema.parse({
    sectionId,
    inputs,
    ...saved,
    outputHash: hash(JSON.stringify(saved)),
  });
}

/** Any missing/invalid record invalidates the entire prior completeness claim. */
export function reusableSectionRecords(
  previous: unknown,
  sectionIds: readonly string[],
  sharedEscalationEnabled: boolean,
): Map<string, SectionSynthesisRecord> {
  const parsed = sectionSynthesisSchema.safeParse(previous);
  if (sharedEscalationEnabled || !parsed.success) return new Map();
  const records = parsed.data.records;
  const byId = new Map(records.map((record) => [record.sectionId, record]));
  if (
    records.length !== sectionIds.length ||
    byId.size !== records.length ||
    sectionIds.some((id) => !byId.has(id)) ||
    records.some((record) => {
      const { markdown, warnings, metadata, evidence } = record;
      const { score } = record;
      return (
        record.outputHash !==
        hash(JSON.stringify({ markdown, warnings, score, metadata, evidence }))
      );
    })
  )
    return new Map();
  return byId;
}
