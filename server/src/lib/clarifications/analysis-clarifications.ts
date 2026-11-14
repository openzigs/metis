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
import { mayRestOnRestrictedRead } from "../analysis/pass-reads.js";
import { createChildLogger } from "../logger.js";
import { clarificationKey } from "./clarification-key.js";
import {
  indexClarification,
  withdrawClarification,
  type ClarificationIndexDeps,
} from "./clarification-knowledge.js";
import { rerunAfterClarification, type SettledRequirementAnswer } from "./clarification-rerun.js";
import {
  addClarificationRequirements,
  findClarificationsById,
  findSettledClarifications,
  projectProductIds,
  recordClarification,
  reopenChangedSources,
  type ClarificationInput,
  type StoredClarification,
} from "./clarification-records.js";

const log = createChildLogger("analysis-clarifications");

/**
 * The key of a dialog question of analysis `analysisId`; `titleOf` names its
 * requirement. #2310 — the analysis keys a question with no cited paragraph
 * (see `clarificationKey`).
 */
export function keyOfQuestion(
  q: ClarifyingQuestion,
  titleOf: (requirementId: string) => string | undefined,
  analysisId: string,
): string {
  return clarificationKey({
    question: q.question,
    ambiguityField: q.ambiguityField,
    requirementTitle: titleOf(q.requirementId),
    analysisId,
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
 * not among them: its record already exists. #2310 — with `rounds`, only the
 * answers of those rounds: a submit records the round it answered, so an
 * earlier round's answer in an older analysis never overwrites a newer answer
 * to the same question, nor re-settles a record reopened since.
 */
export function answeredClarificationInputs(
  state: ClarificationState,
  requirements: StructuredRequirements | undefined,
  ctx: {
    analysisId: string;
    answeredById: string | null;
    productIds: string[];
    now: Date;
    rounds?: ReadonlySet<number>;
  },
): ClarificationInput[] {
  const titles = new Map((requirements?.requirements ?? []).map((r) => [r.id, r.title]));
  const out = new Map<string, ClarificationInput>();
  for (const round of state.rounds ?? []) {
    if (ctx.rounds && !ctx.rounds.has(round.round)) continue;
    const submitted = new Map((round.answers ?? []).map((a) => [a.questionId, a.answer]));
    for (const q of round.questions ?? []) {
      const answer = (q.answer ?? submitted.get(q.id) ?? "").trim();
      if (answer.length === 0) continue;
      const questionKey = keyOfQuestion(q, (id) => titles.get(id), ctx.analysisId);
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

/**
 * Every answer the dialog holds for a requirement's wording, in the dialog's
 * order: each question's latest answer (a later round's answer to the same
 * question replaces the earlier one in place), then each answer reused from a
 * project record. Governing answers settle rules, not wording, and are left
 * out. These are the answers `applyClarificationsToRequirements` writes into
 * the requirement body, so a re-decision judges what the body says.
 *
 * #2310 (decided) — a reused answer counts even when another analysis has
 * reopened its record since. A record is reopened because the paragraph it
 * was asked about changed in a newer version of the document; this analysis
 * read the paragraph the answer was given for, so the answer still holds
 * here, and the body keeps it too.
 */
export function settledRequirementAnswers(
  state: ClarificationState,
  requirements: StructuredRequirements | undefined,
  analysisId: string,
): SettledRequirementAnswer[] {
  const out: SettledRequirementAnswer[] = [];
  const inputs = answeredClarificationInputs(state, requirements, {
    analysisId,
    answeredById: null,
    productIds: [],
    now: new Date(0),
  });
  for (const i of inputs) {
    if (i.ambiguityField == null) continue;
    out.push({
      key: i.questionKey,
      question: i.question,
      answer: i.answer,
      requirementIds: i.requirementIds,
    });
  }
  for (const r of state.reused ?? []) {
    const answer = r.answer.trim();
    if (r.governing || answer.length === 0) continue;
    const key = `record:${r.recordId}`;
    if (out.some((a) => a.key === key)) continue;
    out.push({ key, question: r.question, answer, requirementIds: [r.requirementId] });
  }
  return out;
}

export interface RecordAnalysisClarificationsInput {
  projectId: string;
  analysisId: string;
  /** The user who submitted the answers. */
  answeredById: string | null;
  state: ClarificationState;
  requirements: StructuredRequirements | undefined;
  now?: Date;
  /** #2310 — only these rounds' answers (the round just answered); default every round. */
  rounds?: readonly number[];
}

/**
 * Store the dialog's answers as project records. Returns the records whose
 * answer is new or changed: those are the ones to index and re-run. A record
 * that could not be written is logged and left out; the dialog's own copy of
 * the answer stands either way.
 */
export async function recordAnalysisClarifications(
  input: RecordAnalysisClarificationsInput,
): Promise<StoredClarification[]> {
  const inputs = answeredClarificationInputs(input.state, input.requirements, {
    analysisId: input.analysisId,
    answeredById: input.answeredById,
    productIds: await projectProductIds(input.projectId),
    now: input.now ?? new Date(),
    ...(input.rounds ? { rounds: new Set(input.rounds) } : {}),
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
 * project's knowledge so the old answer is no longer cited. `analysisId` is
 * the analysis asking (#2310: it keys a question with no cited paragraph).
 */
export function priorAnswerSourceFor(
  projectId: string,
  analysisId: string,
  deps: Pick<ClarificationIndexDeps, "deleteDocument"> = {},
): PriorAnswerSource {
  return {
    async find(questions, titleOf) {
      const keyed = questions.map((q) => ({
        id: q.id,
        key: keyOfQuestion(q, titleOf, analysisId),
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
  /**
   * #2310 — the rounds whose answers are recorded: the round the submit
   * answered. Default every round.
   */
  rounds?: readonly number[];
}

export interface ClarificationKnowledgeDeps {
  index?: typeof indexClarification;
  rerun?: typeof rerunAfterClarification;
  /** #2506 — test seam: withdraws a record's earlier document instead of indexing it. */
  withdraw?: typeof withdrawClarification;
}

/**
 * After a round is answered: store its answers as project records, index the
 * new and changed ones in the project's RAG store, and re-run what they
 * change. Runs after the answers are committed; never throws. Returns the
 * records that changed.
 */
export async function persistClarificationKnowledge(
  input: ClarificationKnowledgeInput,
  deps: ClarificationKnowledgeDeps = {},
): Promise<StoredClarification[]> {
  try {
    const state = await readDialogState(input.analysisId);
    if (!state) return [];
    const requirements = (await getStructuredRequirements(input.analysisId)) ?? undefined;
    const changed = await recordAnalysisClarifications({
      projectId: input.projectId,
      analysisId: input.analysisId,
      answeredById: input.answeredById,
      state,
      requirements,
      ...(input.rounds ? { rounds: input.rounds } : {}),
    });
    if (changed.length === 0) return [];
    // #2506 — an indexed record is a document every member may search unless
    // its cited paragraph's access list says otherwise, and its question may
    // restate text a pass of this run read from a restricted source (with its
    // starter's access). So a run that may rest on such a read indexes none of
    // them, and withdraws the earlier answer's document a changed record had:
    // the records stay, for this run's dialog (which only a reader who can see
    // the run as a whole is shown) and its re-run. A marker that cannot be
    // read counts as restricted.
    const restricted = await mayRestOnRestrictedRead(input.analysisId).catch(() => true);
    const index = deps.index ?? indexClarification;
    const withdraw = deps.withdraw ?? withdrawClarification;
    for (const record of changed) await (restricted ? withdraw(record) : index(record));
    await (deps.rerun ?? rerunAfterClarification)({
      analysisId: input.analysisId,
      projectId: input.projectId,
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      records: changed,
      settled: settledRequirementAnswers(state, requirements, input.analysisId),
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

export interface ReusedClarificationInput {
  projectId: string;
  analysisId: string;
  provider: AIProvider;
  model?: string;
  /** The round the answers were reused in. */
  round: number;
}

/**
 * #2310 — after a round reused settled answers: each record's
 * `requirementIds` is extended to the requirement it now applies to, and what
 * the answer changes for that requirement is re-run, as for an answer typed in
 * this analysis (code mapping and governing impact). The record is not
 * written again nor re-indexed: its answer did not change. Runs after the
 * answers are written into the requirement bodies; never throws. Returns how
 * many reused answers were re-run.
 */
export async function rerunReusedClarifications(
  input: ReusedClarificationInput,
  deps: Pick<ClarificationKnowledgeDeps, "rerun"> = {},
): Promise<number> {
  try {
    const state = await readDialogState(input.analysisId);
    const reused = (state?.reused ?? []).filter(
      (r) => r.round === input.round && !r.governing && r.answer.trim().length > 0,
    );
    if (!state || reused.length === 0) return 0;
    const stored = await findClarificationsById(
      input.projectId,
      reused.map((r) => r.recordId),
    );
    const records: StoredClarification[] = [];
    for (const r of reused) {
      const record = stored.get(r.recordId);
      if (!record) continue;
      await addClarificationRequirements(input.projectId, record.id, input.analysisId, [
        r.requirementId,
      ]);
      // As this analysis wrote it into the requirement body, for this
      // analysis's requirement only.
      records.push({
        ...record,
        question: r.question,
        answer: r.answer,
        requirementIds: [r.requirementId],
      });
    }
    if (records.length === 0) return 0;
    const requirements = (await getStructuredRequirements(input.analysisId)) ?? undefined;
    await (deps.rerun ?? rerunAfterClarification)({
      analysisId: input.analysisId,
      projectId: input.projectId,
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      records,
      settled: settledRequirementAnswers(state, requirements, input.analysisId),
    });
    return records.length;
  } catch (err) {
    log.warn("reused clarification answers could not be re-run", {
      analysisId: input.analysisId,
      error: (err as Error).message,
    });
    return 0;
  }
}
