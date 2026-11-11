/**
 * Issue #2236 — a requirements analysis's clarification dialog, joined to the
 * project's clarification records: every answer given in the dialog is stored
 * as a record (and indexed), and the dialog reads the records before it asks,
 * so a question the project has settled is not asked again.
 */
import type { PriorAnswer, PriorAnswerSource } from "../analysis/clarification-dialog.js";
import type {
  ClarificationState,
  ClarifyingQuestion,
  StructuredRequirements,
} from "../analysis/types/requirements.js";
import type { AIProvider } from "../ai/types.js";
import { readDialogState } from "../analysis/clarification-dialog-store.js";
import { getStructuredRequirements } from "../analysis/analysis-service.js";
import { createChildLogger } from "../logger.js";
import { clarificationKey } from "./clarification-key.js";
import {
  indexClarification,
  withdrawClarification,
  type ClarificationIndexDeps,
} from "./clarification-knowledge.js";
import { rerunAfterClarification } from "./clarification-rerun.js";
import {
  findSettledClarifications,
  projectProductIds,
  recordClarification,
  reopenChangedSources,
  type ClarificationInput,
  type StoredClarification,
} from "./clarification-records.js";

const log = createChildLogger("analysis-clarifications");

/** The key of a dialog question; `titleOf` names its requirement. */
export function keyOfQuestion(
  q: ClarifyingQuestion,
  titleOf: (requirementId: string) => string | undefined,
): string {
  return clarificationKey({
    question: q.question,
    ambiguityField: q.ambiguityField,
    requirementTitle: titleOf(q.requirementId),
    ...(q.citation ? { citation: q.citation } : {}),
    ...(q.governing ? { governing: q.governing } : {}),
  });
}

/** The requirement an answer applies to: the governing link's, else the question's. */
function requirementIdsOf(q: ClarifyingQuestion): string[] {
  const id = q.governing?.requirementId ?? q.requirementId;
  return id ? [id] : [];
}

/**
 * Every question answered in the dialog, as record inputs. A reused answer is
 * not among them: its record already exists.
 */
export function answeredClarificationInputs(
  state: ClarificationState,
  requirements: StructuredRequirements | undefined,
  ctx: { analysisId: string; answeredById: string | null; productIds: string[]; now: Date },
): ClarificationInput[] {
  const titles = new Map((requirements?.requirements ?? []).map((r) => [r.id, r.title]));
  const out = new Map<string, ClarificationInput>();
  for (const round of state.rounds ?? []) {
    const submitted = new Map((round.answers ?? []).map((a) => [a.questionId, a.answer]));
    for (const q of round.questions ?? []) {
      const answer = (q.answer ?? submitted.get(q.id) ?? "").trim();
      if (answer.length === 0) continue;
      const questionKey = keyOfQuestion(q, (id) => titles.get(id));
      // A later round's answer to the same question replaces an earlier one.
      out.set(questionKey, {
        origin: "analysis",
        questionKey,
        analysisId: ctx.analysisId,
        questionId: q.id,
        question: q.question,
        answer,
        answeredById: ctx.answeredById,
        answeredAt: ctx.now,
        ambiguityField: q.governing ? null : q.ambiguityField,
        source: q.citation
          ? {
              ...(q.citation.documentId ? { documentId: q.citation.documentId } : {}),
              ...(q.citation.filename ? { filename: q.citation.filename } : {}),
              headingPath: [...q.citation.headingPath],
              quote: q.citation.quote,
            }
          : null,
        requirementIds: requirementIdsOf(q),
        productIds: ctx.productIds,
      });
    }
  }
  return [...out.values()];
}

export interface RecordAnalysisClarificationsInput {
  projectId: string;
  analysisId: string;
  /** The user who submitted the answers. */
  answeredById: string | null;
  state: ClarificationState;
  requirements: StructuredRequirements | undefined;
  now?: Date;
}

/**
 * Store every answer of the dialog as a project record. Returns the records
 * whose answer is new or changed: those are the ones to index and re-run. A
 * record that could not be written is logged and left out; the dialog's own
 * copy of the answer stands either way.
 */
export async function recordAnalysisClarifications(
  input: RecordAnalysisClarificationsInput,
): Promise<StoredClarification[]> {
  const inputs = answeredClarificationInputs(input.state, input.requirements, {
    analysisId: input.analysisId,
    answeredById: input.answeredById,
    productIds: await projectProductIds(input.projectId),
    now: input.now ?? new Date(),
  });
  const changed: StoredClarification[] = [];
  for (const one of inputs) {
    try {
      const { record, changed: isNew } = await recordClarification(input.projectId, one);
      if (isNew) changed.push(record);
    } catch (err) {
      log.warn("a clarification answer could not be recorded", {
        analysisId: input.analysisId,
        questionId: one.questionId,
        error: (err as Error).message,
      });
    }
  }
  return changed;
}

/**
 * The dialog's {@link PriorAnswerSource} for one project: a question is
 * answered by the settled record under its key. Before reading, a record asked
 * about a paragraph that has since changed is reopened, so the changed
 * paragraph is asked about again, and its document is withdrawn from the
 * project's knowledge so the old answer is no longer cited.
 */
export function priorAnswerSourceFor(
  projectId: string,
  deps: Pick<ClarificationIndexDeps, "deleteDocument"> = {},
): PriorAnswerSource {
  return {
    async find(questions, titleOf) {
      const keyed = questions.map((q) => ({
        id: q.id,
        key: keyOfQuestion(q, titleOf),
        question: {
          question: q.question,
          ambiguityField: q.ambiguityField,
          ...(q.citation ? { citation: q.citation } : {}),
        },
      }));
      for (const reopened of await reopenChangedSources(projectId, keyed)) {
        await withdrawClarification(reopened, deps);
      }
      const settled = await findSettledClarifications(
        projectId,
        keyed.map((k) => k.key),
      );
      const out = new Map<string, PriorAnswer>();
      for (const k of keyed) {
        const record = settled.get(k.key);
        if (!record) continue;
        out.set(k.id, {
          recordId: record.id,
          answer: record.answer,
          answeredAt: record.answeredAt.toISOString(),
          ...(record.analysisId ? { fromAnalysisId: record.analysisId } : {}),
        });
      }
      return out;
    },
  };
}

export interface ClarificationKnowledgeInput {
  projectId: string;
  analysisId: string;
  /** The user who submitted the answers. */
  answeredById: string | null;
  provider: AIProvider;
  model?: string;
}

export interface ClarificationKnowledgeDeps {
  index?: typeof indexClarification;
  rerun?: typeof rerunAfterClarification;
}

/**
 * After a round is answered (or answers were reused): store the dialog's
 * answers as project records, index the new and changed ones in the project's
 * RAG store, and re-run what they change. Runs after the answers are
 * committed; never throws. Returns the records that changed.
 */
export async function persistClarificationKnowledge(
  input: ClarificationKnowledgeInput,
  deps: ClarificationKnowledgeDeps = {},
): Promise<StoredClarification[]> {
  try {
    const state = await readDialogState(input.analysisId);
    if (!state) return [];
    const changed = await recordAnalysisClarifications({
      projectId: input.projectId,
      analysisId: input.analysisId,
      answeredById: input.answeredById,
      state,
      requirements: (await getStructuredRequirements(input.analysisId)) ?? undefined,
    });
    if (changed.length === 0) return [];
    const index = deps.index ?? indexClarification;
    for (const record of changed) await index(record);
    await (deps.rerun ?? rerunAfterClarification)({
      analysisId: input.analysisId,
      projectId: input.projectId,
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      records: changed,
    });
    return changed;
  } catch (err) {
    log.warn("clarification answers could not be kept as project knowledge", {
      analysisId: input.analysisId,
      error: (err as Error).message,
    });
    return [];
  }
}
