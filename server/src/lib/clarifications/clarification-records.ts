/**
 * Issue #2236 — clarification answers as first-class project records
 * (`clarification_records`): the question, the answer, who gave it and when,
 * the source paragraph it was asked about, and the requirements and products
 * it applies to.
 *
 * One row per (project, question key) — `clarificationKey` decides when two
 * questions are the same one — so an answer given in one analysis is found by
 * the next analysis of the project instead of the question being asked again.
 *
 * Security: every query filters on `projectId` as well as the key or id, so a
 * record of one project can never be read or reopened through another. Ids
 * and text are bound Prisma values, never interpolated into SQL.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { isUniqueViolation } from "../db/prisma-errors.js";
import {
  paragraphSimilarity,
  SAME_PARAGRAPH_THRESHOLD,
  sourceSlot,
  type KeyableQuestion,
} from "./clarification-key.js";

const log = createChildLogger("clarification-records");

export const CLARIFICATION_ORIGINS = ["analysis", "spec-kit"] as const;
export type ClarificationOrigin = (typeof CLARIFICATION_ORIGINS)[number];

/** The paragraph of a document a question was asked about. */
export interface ClarificationSource {
  documentId?: string;
  filename?: string;
  headingPath: string[];
  quote: string;
}

/** What a caller records for one answered question. */
export interface ClarificationInput {
  origin: ClarificationOrigin;
  questionKey: string;
  analysisId?: string | null;
  specKitFeature?: string | null;
  questionId?: string | null;
  question: string;
  answer: string;
  answeredById?: string | null;
  answeredAt: Date;
  ambiguityField?: string | null;
  source?: ClarificationSource | null;
  requirementIds: readonly string[];
  productIds: readonly string[];
}

export type ClarificationStatus = "settled" | "reopened";

/** A stored record, as the rest of the server reads it. */
export interface StoredClarification {
  id: string;
  projectId: string;
  origin: ClarificationOrigin;
  questionKey: string;
  analysisId: string | null;
  specKitFeature: string | null;
  questionId: string | null;
  question: string;
  answer: string;
  answeredById: string | null;
  answeredAt: Date;
  ambiguityField: string | null;
  source: ClarificationSource | null;
  requirementIds: string[];
  productIds: string[];
  status: ClarificationStatus;
  reopenedAt: Date | null;
  knowledgeDocumentId: string | null;
}

type Row = NonNullable<Awaited<ReturnType<typeof prisma.clarificationRecord.findFirst>>>;

/** A JSON string array column, read defensively: anything else reads as empty. */
function stringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toStored(row: Row): StoredClarification {
  const headingPath = stringArray(row.sourceHeadingPath);
  return {
    id: row.id,
    projectId: row.projectId,
    origin: row.origin === "spec-kit" ? "spec-kit" : "analysis",
    questionKey: row.questionKey,
    analysisId: row.analysisId,
    specKitFeature: row.specKitFeature,
    questionId: row.questionId,
    question: row.question,
    answer: row.answer,
    answeredById: row.answeredById,
    answeredAt: row.answeredAt,
    ambiguityField: row.ambiguityField,
    source:
      row.sourceQuote !== null
        ? {
            ...(row.sourceDocumentId ? { documentId: row.sourceDocumentId } : {}),
            ...(row.sourceFilename ? { filename: row.sourceFilename } : {}),
            headingPath,
            quote: row.sourceQuote,
          }
        : null,
    requirementIds: stringArray(row.requirementIds),
    productIds: stringArray(row.productIds),
    status: row.status === "reopened" ? "reopened" : "settled",
    reopenedAt: row.reopenedAt,
    knowledgeDocumentId: row.knowledgeDocumentId,
  };
}

function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

function columns(input: ClarificationInput) {
  return {
    origin: input.origin,
    analysisId: input.analysisId ?? null,
    specKitFeature: input.specKitFeature ?? null,
    questionId: input.questionId ?? null,
    question: input.question,
    answer: input.answer,
    answeredById: input.answeredById ?? null,
    answeredAt: input.answeredAt,
    ambiguityField: input.ambiguityField ?? null,
    sourceDocumentId: input.source?.documentId ?? null,
    sourceFilename: input.source?.filename ?? null,
    sourceHeadingPath: JSON.stringify(input.source?.headingPath ?? []),
    sourceQuote: input.source?.quote ?? null,
    requirementIds: JSON.stringify([...new Set(input.requirementIds)]),
    productIds: JSON.stringify([...new Set(input.productIds)]),
    status: "settled",
    reopenedAt: null,
  };
}

/** What {@link recordClarification} did. */
export interface RecordedClarification {
  record: StoredClarification;
  /**
   * True when the answer is new to the project, or differs from the one
   * recorded before (or that one was reopened): what was answered changed, so
   * the caller indexes it and re-runs what it affects. False when the same
   * answer was already settled; nothing is written then.
   */
  changed: boolean;
}

/**
 * Store one answer under its key, replacing the earlier answer to the same
 * question. Writing the same settled answer again is a no-op.
 */
export async function recordClarification(
  projectId: string,
  input: ClarificationInput,
): Promise<RecordedClarification> {
  const where = { projectId_questionKey: { projectId, questionKey: input.questionKey } };
  const existing = await prisma.clarificationRecord.findUnique({ where });
  if (existing && existing.status === "settled" && sameText(existing.answer, input.answer)) {
    return { record: toStored(existing), changed: false };
  }
  const data = columns(input);
  if (existing) {
    const row = await prisma.clarificationRecord.update({ where, data });
    return { record: toStored(row), changed: true };
  }
  try {
    const row = await prisma.clarificationRecord.create({
      data: { projectId, questionKey: input.questionKey, ...data },
    });
    return { record: toStored(row), changed: true };
  } catch (err) {
    // Two submits of the same question raced: the other one created it.
    if (!isUniqueViolation(err)) throw err;
    const row = await prisma.clarificationRecord.update({ where, data });
    return { record: toStored(row), changed: true };
  }
}

/** The settled records of `projectId` for `keys`, by key. */
export async function findSettledClarifications(
  projectId: string,
  keys: readonly string[],
): Promise<Map<string, StoredClarification>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return new Map();
  const rows = await prisma.clarificationRecord.findMany({
    where: { projectId, status: "settled", questionKey: { in: unique } },
  });
  return new Map(rows.map((r) => [r.questionKey, toStored(r)]));
}

/**
 * The settled records of `projectId` whose paragraph has changed since they
 * were answered: each is marked `reopened` and its question is asked again.
 * Returns what was reopened.
 *
 * A record is reopened by a question of `questions` about its own paragraph,
 * edited: the same document, section and field ({@link sourceSlot}), another
 * key, and a quote that reads as the record's quote edited
 * ({@link paragraphSimilarity} at least {@link SAME_PARAGRAPH_THRESHOLD}). A
 * question about a sibling paragraph of the section — different words — never
 * reopens it. A question whose key a record already has is about an unchanged
 * paragraph and reopens nothing; and a question reopens at most the one record
 * its quote is most like (none on a tie), so two answers are never reopened by
 * one edit.
 */
export async function reopenChangedSources(
  projectId: string,
  questions: ReadonlyArray<{ key: string; question: KeyableQuestion }>,
  now: Date = new Date(),
): Promise<StoredClarification[]> {
  const bySlot = new Map<string, Array<{ key: string; quote: string }>>();
  const documentIds = new Set<string>();
  for (const { key, question } of questions) {
    const slot = sourceSlot(question);
    if (!slot) continue;
    documentIds.add(question.citation!.documentId!);
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), { key, quote: question.citation!.quote }]);
  }
  if (bySlot.size === 0) return [];
  const rows = await prisma.clarificationRecord.findMany({
    where: { projectId, status: "settled", sourceDocumentId: { in: [...documentIds] } },
  });
  const records = rows.map(toStored);
  const known = new Set(records.map((r) => r.questionKey));
  const recordsBySlot = new Map<string, StoredClarification[]>();
  for (const r of records) {
    if (!r.source) continue;
    const slot = sourceSlot({ citation: r.source, ambiguityField: r.ambiguityField ?? undefined });
    if (!slot || !bySlot.has(slot)) continue;
    recordsBySlot.set(slot, [...(recordsBySlot.get(slot) ?? []), r]);
  }
  const changed = new Map<string, StoredClarification>();
  for (const [slot, candidates] of recordsBySlot) {
    const asked = bySlot.get(slot)!;
    const askedKeys = new Set(asked.map((q) => q.key));
    // A record asked about again under its own key: its paragraph is unchanged.
    const open = candidates.filter((r) => !askedKeys.has(r.questionKey));
    for (const q of asked) {
      // A question with a record of its own is about an unchanged paragraph.
      if (known.has(q.key)) continue;
      let best: { record: StoredClarification; score: number } | null = null;
      let tied = false;
      for (const r of open) {
        const score = paragraphSimilarity(q.quote, r.source!.quote);
        if (score < SAME_PARAGRAPH_THRESHOLD) continue;
        if (!best || score > best.score) {
          best = { record: r, score };
          tied = false;
        } else if (score === best.score) {
          tied = true;
        }
      }
      if (best && !tied) changed.set(best.record.id, best.record);
    }
  }
  if (changed.size === 0) return [];
  const reopened = [...changed.values()];
  await prisma.clarificationRecord.updateMany({
    where: { projectId, status: "settled", id: { in: reopened.map((r) => r.id) } },
    data: { status: "reopened", reopenedAt: now },
  });
  log.info("clarification answers reopened: the paragraph they were asked about changed", {
    projectId,
    reopened: reopened.length,
  });
  return reopened.map((r) => ({ ...r, status: "reopened" as const, reopenedAt: now }));
}

/** Record which `documents` row a record is indexed as. */
export async function setClarificationKnowledgeDocument(
  projectId: string,
  recordId: string,
  documentId: string | null,
): Promise<void> {
  await prisma.clarificationRecord.updateMany({
    where: { projectId, id: recordId },
    data: { knowledgeDocumentId: documentId },
  });
}

/** The project's records, newest answer first; optionally one analysis's or one Spec Kit set's. */
export async function listClarifications(
  projectId: string,
  filter: {
    analysisId?: string;
    specKitFeature?: string | null;
    status?: ClarificationStatus;
  } = {},
): Promise<StoredClarification[]> {
  const rows = await prisma.clarificationRecord.findMany({
    where: {
      projectId,
      ...(filter.analysisId !== undefined ? { analysisId: filter.analysisId } : {}),
      ...(filter.specKitFeature !== undefined
        ? { origin: "spec-kit", specKitFeature: filter.specKitFeature }
        : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { answeredAt: "desc" },
  });
  return rows.map(toStored);
}

/** The products a project's answers apply to: the project's product, when it has one. */
export async function projectProductIds(projectId: string): Promise<string[]> {
  const project = await prisma.project.findFirst({
    where: { id: projectId },
    select: { productId: true },
  });
  return project?.productId ? [project.productId] : [];
}
