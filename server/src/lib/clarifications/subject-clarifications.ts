/**
 * Issue #2270 (epic #2227) — the clarifying questions of an Impact Analysis run
 * and of a portfolio check started on a document, through the same path as
 * Requirements Analysis's (#2235).
 *
 * Neither has an analysis, so neither has a requirement list for the dialog to
 * ask about, nor a `ClarificationDialogState` row to keep the dialog in. Both
 * now read their document with the document reader (#2231), so:
 *
 *   1. {@link clarifiableRequirements} — each requirement, constraint or
 *      business rule the reader found is one requirement of the dialog, with
 *      the paragraph it was verified against (`sources`) and the GtWR R7 / R8 /
 *      R9 and placeholder hits on that paragraph as its ambiguities
 *      (`requirement-quality-rules.ts`), as Requirements Analysis flags its
 *      own. A requirement with no hit has nothing to ask and is left out.
 *   2. {@link saveSubjectClarifiable} — the run stores them on its
 *      `SubjectClarificationDialog` row, keyed on the run (or check).
 *   3. {@link startSubjectClarification} / {@link submitSubjectAnswers} — the
 *      same `ClarificationDialog`: the classifying prompt, the selection (set
 *      aside the unanswerable and the same-whichever-way, rank by impact, cap
 *      per round), the citation of the paragraph, the grounding of missing
 *      knowledge, and the reuse of an answer the project already gave (#2236).
 *   4. {@link persistSubjectClarificationKnowledge} — each answer is stored as
 *      a project clarification record (origin `impact` / `portfolio`) and
 *      indexed in the project's RAG store, carrying the document's ACL, so a
 *      later analysis of the project reuses it and chat can cite it.
 *
 * Access is the caller's: every function here takes a dialog the route has
 * already checked the caller may read (the run or check, and its document).
 * Every query is keyed on the subject's own unique column.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { isUniqueViolation } from "../db/prisma-errors.js";
import type { AIProvider } from "../ai/types.js";
import type { DocumentReading } from "../document-reader/reader.js";
import { REQUIREMENT_STATEMENT_KINDS } from "../document-reader/prompts.js";
import { findQualityFlags, qualityFlagAmbiguities } from "../analysis/requirement-quality-rules.js";
import { ClarificationDialog } from "../analysis/clarification-dialog.js";
import type { GroundingRetriever } from "../analysis/ambiguity-grounding.js";
import {
  readDialogState,
  subjectWhere,
  type DialogSubjectKind,
} from "../analysis/clarification-dialog-store.js";
import { runInAnalysisUsageScope } from "../analysis/analysis-usage.js";
import { MAX_CLARIFY_ANSWERS, clarifyAnswerSchema } from "../analysis/clarify-request-schema.js";
import type {
  ClarificationAnswer,
  ClarificationState,
  StructuredRequirement,
  StructuredRequirements,
} from "../analysis/types/requirements.js";
import { answeredClarificationInputs, priorAnswerSourceFor } from "./analysis-clarifications.js";
import { indexClarification } from "./clarification-knowledge.js";
import {
  projectProductIds,
  recordClarification,
  type StoredClarification,
} from "./clarification-records.js";

const log = createChildLogger("subject-clarifications");

/** An Impact Analysis run's (`impact`) or a portfolio check's (`portfolio`) dialog. */
export interface SubjectKey {
  kind: DialogSubjectKind;
  id: string;
}

/** What a run read that the dialog can ask about, and where it read it. */
export interface ClarifiableDocument {
  /** The document's own project: its knowledge grounds, its records keep. */
  projectId: string;
  documentId: string;
  requirements: StructuredRequirements;
}

/** The dialog as stored for a subject. */
export interface SubjectDialog extends ClarifiableDocument {
  state: ClarificationState | null;
}

const TITLE_MAX = 120;

function clipTitle(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 3)}...` : one;
}

/**
 * The dialog's requirements from a reading of document `doc`: one per
 * requirement, constraint or business rule with at least one GtWR hit on its
 * verified paragraph, in document order. `null` when none has a hit: there is
 * nothing to ask. Deterministic: no model call.
 */
export function clarifiableRequirements(
  reading: Pick<DocumentReading, "statements">,
  doc: { documentId: string; title: string },
): StructuredRequirements | null {
  const requirements: StructuredRequirement[] = [];
  for (const s of reading.statements) {
    if (!REQUIREMENT_STATEMENT_KINDS.has(s.kind)) continue;
    const ambiguities = qualityFlagAmbiguities(findQualityFlags(s.quote));
    if (ambiguities.length === 0) continue;
    requirements.push({
      id: s.id,
      title: clipTitle(s.statement),
      description: s.statement,
      type: s.kind === "constraint" ? "constraint" : "functional",
      stakeholders: [],
      priority: "should-have",
      ambiguities,
      evidenceNeeds: [],
      rawSource: s.quote,
      sources: [
        {
          ref: s.id,
          documentId: doc.documentId,
          filename: doc.title,
          headingPath: [...s.headingPath],
          quote: s.quote,
        },
      ],
    });
  }
  if (requirements.length === 0) return null;
  return {
    requirements,
    totalAmbiguities: requirements.reduce((n, r) => n + r.ambiguities.length, 0),
    totalEvidenceNeeds: 0,
  };
}

/**
 * Store what the run read for its dialog. Written once per run (a run or check
 * is never executed twice); a second write replaces the requirements and
 * clears any state, so the dialog always asks about what the row says.
 */
export async function saveSubjectClarifiable(
  key: SubjectKey,
  doc: ClarifiableDocument,
): Promise<void> {
  const data = {
    projectId: doc.projectId,
    documentId: doc.documentId,
    requirements: JSON.stringify(doc.requirements),
    state: null,
  };
  const where = subjectWhere(key);
  try {
    await prisma.subjectClarificationDialog.create({ data: { ...where, ...data } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    await prisma.subjectClarificationDialog.updateMany({ where, data });
  }
}

function parseRequirements(raw: string): StructuredRequirements | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StructuredRequirements> | null;
    if (!parsed || !Array.isArray(parsed.requirements)) return null;
    return {
      requirements: parsed.requirements,
      totalAmbiguities: parsed.totalAmbiguities ?? 0,
      totalEvidenceNeeds: parsed.totalEvidenceNeeds ?? 0,
    };
  } catch {
    return null;
  }
}

/** The subject's dialog, or `null` when it has none (or its row cannot be read). */
export async function readSubjectDialog(key: SubjectKey): Promise<SubjectDialog | null> {
  const row = await prisma.subjectClarificationDialog.findUnique({
    where: subjectWhere(key) as Prisma.SubjectClarificationDialogWhereUniqueInput,
    select: { projectId: true, documentId: true, requirements: true },
  });
  if (!row) return null;
  const requirements = parseRequirements(row.requirements);
  if (!requirements) {
    log.warn("A clarification dialog's requirements could not be read — no dialog", {
      kind: key.kind,
      id: key.id,
    });
    return null;
  }
  return {
    projectId: row.projectId,
    documentId: row.documentId,
    requirements,
    state: (await readDialogState(key)) ?? null,
  };
}

/** The body of `POST …/clarify` on a subject: no body starts, `answers` submits. */
export const subjectClarifyRequestSchema = z.strictObject({
  answers: z.array(clarifyAnswerSchema).max(MAX_CLARIFY_ANSWERS).optional(),
});

export interface SubjectClarifyContext {
  key: SubjectKey;
  dialog: SubjectDialog;
  /** Metered: the calls are billed to the dialog's project. */
  provider: AIProvider;
  /** Searches the project's knowledge for missing knowledge; absent, nothing is searched. */
  retriever?: GroundingRetriever;
  signal?: AbortSignal;
}

/** Who the dialog's model calls are billed to: the document's project, this subject's session. */
function usageScope(ctx: SubjectClarifyContext) {
  return { projectId: ctx.dialog.projectId, sessionId: `${ctx.key.kind}:${ctx.key.id}` };
}

function dialogFor(ctx: SubjectClarifyContext): ClarificationDialog {
  return new ClarificationDialog({
    provider: ctx.provider,
    ...(ctx.retriever ? { retriever: ctx.retriever } : {}),
    projectId: ctx.dialog.projectId,
    subject: ctx.key.kind,
    // #2236 — a question the project already settled is not asked again.
    priorAnswers: priorAnswerSourceFor(ctx.dialog.projectId, ctx.key.id),
  });
}

/** Start the dialog, or return its open round. */
export async function startSubjectClarification(
  ctx: SubjectClarifyContext,
): Promise<ClarificationState> {
  return runInAnalysisUsageScope(usageScope(ctx), () =>
    dialogFor(ctx).startOrContinue(ctx.key.id, ctx.dialog.requirements, ctx.signal),
  );
}

/**
 * Submit the open round's answers. The refined requirements are written with
 * the round, in its transaction, so the two land together or not at all.
 */
export async function submitSubjectAnswers(
  ctx: SubjectClarifyContext,
  answers: ClarificationAnswer[],
): Promise<{ state: ClarificationState; updatedRequirements: StructuredRequirements }> {
  const where = subjectWhere(ctx.key);
  return runInAnalysisUsageScope(usageScope(ctx), () =>
    dialogFor(ctx).submitAnswers(
      ctx.key.id,
      answers,
      ctx.dialog.requirements,
      ctx.signal,
      async ({ updatedRequirements }, tx) => {
        await tx.subjectClarificationDialog.updateMany({
          where,
          data: { requirements: JSON.stringify(updatedRequirements) },
        });
      },
    ),
  );
}

export interface SubjectKnowledgeInput {
  key: SubjectKey;
  projectId: string;
  /** The user who submitted the answers. */
  answeredById: string | null;
  /** The round the submit answered: only its answers are recorded (#2310). */
  rounds?: readonly number[];
}

export interface SubjectKnowledgeDeps {
  index?: typeof indexClarification;
}

/**
 * After a round is answered: store its answers as the project's clarification
 * records and index the new and changed ones, as a requirements analysis's
 * are (#2236). The indexed document carries the cited document's ACL
 * (`indexClarification`). Runs after the answers are committed; never throws.
 * Returns the records that changed.
 *
 * Not done here, unlike an analysis: re-running what the answer changes. An
 * impact run or a check is a result, re-run as a new one (#965); the answers
 * reach that one as reused answers.
 */
export async function persistSubjectClarificationKnowledge(
  input: SubjectKnowledgeInput,
  deps: SubjectKnowledgeDeps = {},
): Promise<StoredClarification[]> {
  try {
    const dialog = await readSubjectDialog(input.key);
    if (!dialog?.state) return [];
    const inputs = answeredClarificationInputs(dialog.state, dialog.requirements, {
      analysisId: input.key.id,
      answeredById: input.answeredById,
      productIds: await projectProductIds(input.projectId),
      now: new Date(),
      origin: input.key.kind,
      ...(input.rounds ? { rounds: new Set(input.rounds) } : {}),
    });
    const changed: StoredClarification[] = [];
    for (const one of inputs) {
      try {
        const { record, changed: isNew } = await recordClarification(input.projectId, one);
        if (isNew) changed.push(record);
      } catch (err) {
        log.warn("a clarification answer could not be recorded", {
          kind: input.key.kind,
          id: input.key.id,
          questionId: one.questionId,
          error: (err as Error).message,
        });
      }
    }
    const index = deps.index ?? indexClarification;
    for (const record of changed) await index(record);
    return changed;
  } catch (err) {
    log.warn("clarification answers could not be kept as project knowledge", {
      kind: input.key.kind,
      id: input.key.id,
      error: (err as Error).message,
    });
    return [];
  }
}
