/**
 * Clarification Dialog System (Epic #597 / Issue #624).
 *
 * Generates clarifying questions from requirement ambiguities,
 * supports multi-turn dialog (up to 3 rounds), and escalates from
 * Haiku to Sonnet when uncertainty exceeds a threshold.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AIProvider, ChatMessage } from "../ai/types.js";
import { HAIKU_MODEL_ID, SONNET_MODEL_ID, tierModelFor } from "../ai/model-router.js";
import { createChildLogger } from "../logger.js";
import { AppError } from "../../middleware/error-handler.js";
import { extractJsonObject } from "./agent-runner.js";
import { AmbiguityGrounding, type GroundingRetriever } from "./ambiguity-grounding.js";
import {
  hasVerdict,
  jsonObjectWhereDeclared,
  requestStructuredVerdict,
} from "./structured-verdict.js";
import { noUsableItem } from "./unread-reply.js";
import {
  deleteDialogState,
  readDialogState,
  readDialogStateRevision,
  replaceDialogState,
  writeDialogState,
} from "./clarification-dialog-store.js";
import type { GoverningQuestionSource } from "../governing/applicability-questions.js";
import { addressedAmbiguities } from "./types/requirements.js";
import type {
  ClarificationAnswer,
  ClarificationRound,
  ClarificationState,
  ClarifyingQuestion,
  StructuredRequirement,
  StructuredRequirements,
} from "./types/requirements.js";

const log = createChildLogger("clarification-dialog");

/**
 * Issue #382 — a requirement stored before ambiguities were extracted, or
 * emitted by a model that omitted the field, has no `ambiguities` array. It has
 * no open questions, so default it to `[]` once at the dialog's entry points
 * rather than letting every `r.ambiguities` read below throw into a 500.
 */
export function withAmbiguityDefaults(
  requirements: StructuredRequirements,
): StructuredRequirements {
  return {
    ...requirements,
    requirements: requirements.requirements.map((r) =>
      Array.isArray(r.ambiguities) ? r : { ...r, ambiguities: [] },
    ),
  };
}

export const MAX_ROUNDS = 3;

/**
 * Issue #937 — starts currently generating, keyed `analysisId:round`. Process
 * local: it dedupes a double POST against one server; the persisted-round check
 * in `runStart` covers any start that arrives after the first was written.
 */
const startsInFlight = new Map<string, Promise<ClarificationState>>();

/**
 * #2016 — the backoff of the start path's retry of governing answers whose
 * settle failed. That retry runs inline in a start, before the #937 early
 * return, and costs up to two judging calls per question it judges; with the
 * provider down, every start (each Questions-tab mount) paid them again. After
 * a retry that left an answer open, the next start-path retry of the analysis
 * waits {@link ORPHAN_RETRY_BASE_MS}, doubling per attempt up to
 * {@link ORPHAN_RETRY_MAX_MS}. A retry that left nothing open (#2022: it
 * settled every answer, or had none to judge) clears it, and so does a
 * submit, which settles itself; a retry the client aborted leaves it as it
 * was. Process local, as `startsInFlight` is, and bounded at
 * {@link ORPHAN_RETRY_MAX_ENTRIES} analyses, the least recently backed off
 * evicted first.
 */
export const ORPHAN_RETRY_BASE_MS = 60_000;
export const ORPHAN_RETRY_MAX_MS = 60 * 60_000;
export const ORPHAN_RETRY_MAX_ENTRIES = 1_000;
const orphanRetries = new Map<string, { attempts: number; nextAt: number }>();

const ESCALATION_THRESHOLD = 0.6; // >60% unresolved → escalate to Sonnet

// ── Prompts ────────────────────────────────────────────────────────────

export const QUESTION_SYSTEM_PROMPT = `You are a requirements analyst conducting a clarification session. Given requirements with identified ambiguities, generate targeted clarifying questions.

For each ambiguity, produce a JSON object:
- requirementId: the requirement's id
- ambiguityField: the ambiguous field name
- question: a clear, specific question to resolve the ambiguity
- context: brief context explaining why this is ambiguous

Respond ONLY with a JSON object: { "questions": [...] }
Do not include markdown fences or commentary.`;

export const RESOLUTION_SYSTEM_PROMPT = `You are a requirements analyst. Given a requirement with ambiguities and the user's clarification answers, update the requirement to resolve the ambiguities.

Respond ONLY with a JSON object containing:
- resolvedFields: array of field names that are now resolved
- updatedDescription: the updated requirement description incorporating the clarifications
- remainingUncertainty: a number 0-1 indicating how much uncertainty remains (0 = fully resolved)

Do not include markdown fences or commentary.`;

// ── Durable dialog state store (Epic #201 / #210) ──────────────────────
//
// State now lives in the `ClarificationDialogState` Prisma table instead of a
// module-level Map, so in-flight clarification survives a server restart. The
// public helpers keep their names but are now async (DB-backed).

export async function getDialogState(analysisId: string): Promise<ClarificationState | undefined> {
  return readDialogState(analysisId);
}

export async function clearDialogState(analysisId: string): Promise<void> {
  await deleteDialogState(analysisId);
}

/** @internal — exposed for testing; persists state to the durable store. */
export async function _setDialogState(
  analysisId: string,
  state: ClarificationState,
): Promise<void> {
  await writeDialogState(analysisId, state);
}

// ── Pure prompt builders (shared with the e2e fixture builder, #235) ─────
//
// Extracted so the record/replay fixture builder can compute the exact
// `fixtureKey()` for each clarification `chat()` call without duplicating the
// prompt strings (which would silently drift from the live logic).

/** Build the round's ambiguity summary block from unresolved ambiguities. */
export function buildAmbiguitySummary(
  requirements: StructuredRequirement[],
  resolvedAmbiguities: string[],
): string {
  return requirements
    .map((r) => {
      const unresolved = r.ambiguities.filter(
        (a) => !resolvedAmbiguities.includes(`${r.id}:${a.field}`),
      );
      return `Requirement "${r.title}" (id: ${r.id}):\n${unresolved
        .map((a) => `  - ${a.field}: ${a.description}`)
        .join("\n")}`;
    })
    .join("\n\n");
}

/** Build the `chat()` messages for the question-generation call. */
export function buildQuestionMessages(
  requirements: StructuredRequirement[],
  currentRound: number,
  resolvedAmbiguities: string[],
): ChatMessage[] {
  const ambiguitySummary = buildAmbiguitySummary(requirements, resolvedAmbiguities);
  return [
    { role: "system", content: QUESTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Round ${currentRound}/${MAX_ROUNDS}. Generate clarifying questions for these ambiguities:\n\n${ambiguitySummary}`,
    },
  ];
}

/** Build the `chat()` messages for the per-requirement resolution call. */
export function buildResolutionMessages(
  req: { title: string; description: string },
  qaBlock: string,
): ChatMessage[] {
  return [
    { role: "system", content: RESOLUTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Requirement: ${req.title}\nDescription: ${req.description}\n\nClarifications:\n${qaBlock}`,
    },
  ];
}

// ── Main class ─────────────────────────────────────────────────────────

export interface ClarificationDialogDeps {
  provider: AIProvider;
  model?: string;
  /**
   * Optional project retrieval surface + project id. When BOTH are present and
   * the provider is not offline, generated clarifying questions are first run
   * through a retrieval-grounded self-resolution pass before being surfaced.
   * Kept optional so existing construction/tests are unaffected.
   */
  retriever?: GroundingRetriever;
  projectId?: string;
  /**
   * Issue #1129 — requirement ids whose questions are asked FIRST. On a run
   * started from ticked imported items these are the requirements that restate
   * a ticked item; the analysis's own additions follow, so five ticked items
   * are never buried under 29 questions about features nobody asked for.
   */
  askFirst?: ReadonlySet<string>;
  /**
   * #1873 — the plain business questions that settle `uncertain` governing
   * rules, and where their answers go. Absent while `GOVERNING_DOCS_ENABLED`
   * is off (`governingQuestionSourceFor`), which leaves the dialog unchanged.
   */
  governingQuestions?: GoverningQuestionSource;
}

/** Stable partition: questions about `askFirst` requirements, then the rest. */
export function orderQuestionsAskFirst<T extends { requirementId: string }>(
  questions: readonly T[],
  askFirst: ReadonlySet<string> | undefined,
): T[] {
  if (!askFirst || askFirst.size === 0) return [...questions];
  return [
    ...questions.filter((q) => askFirst.has(q.requirementId)),
    ...questions.filter((q) => !askFirst.has(q.requirementId)),
  ];
}

export class ClarificationDialog {
  private readonly provider: AIProvider;
  private readonly model: string | undefined;
  private readonly retriever: GroundingRetriever | undefined;
  private readonly projectId: string | undefined;
  private readonly askFirst: ReadonlySet<string> | undefined;
  private readonly governing: GoverningQuestionSource | undefined;

  constructor(deps: ClarificationDialogDeps) {
    this.provider = deps.provider;
    this.model = deps.model;
    this.retriever = deps.retriever;
    this.projectId = deps.projectId;
    this.askFirst = deps.askFirst;
    this.governing = deps.governingQuestions;
  }

  /**
   * #1873 — the governing questions for the round being generated. A failure
   * here never stops the ambiguity questions: it is logged and asks none.
   */
  private async governingQuestionsFor(
    state: ClarificationState,
    signal: AbortSignal | undefined,
  ): Promise<ClarifyingQuestion[]> {
    if (!this.governing) return [];
    try {
      return await this.governing.open(state, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      log.warn("Governing questions could not be generated — asking none this round", {
        error: (err as Error).message,
      });
      return [];
    }
  }

  /**
   * #2009 — judge every answered governing question of the dialog whose pairs
   * are still open back onto them: the current round's, and any whose earlier
   * settle failed (the provider threw or was offline, the reply could not be
   * read, the request was aborted). Such a pair is never asked again, so this
   * retry is the only way its answer is ever used. A failure is logged: the
   * answers are kept, and the next settle tries again. #2016 / #2022 — true
   * when the settle left an answered pair open: a judging call failed, its
   * reply could not be read, or the settle threw. #2029 — whether the request
   * was aborted is the caller's to read from the signal (a client that went
   * away is no failed attempt); here an abort only goes unlogged.
   */
  private async settleGoverning(
    analysisId: string,
    state: ClarificationState,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (!this.governing) return false;
    const questions = state.rounds.flatMap((r) => r.questions);
    if (!questions.some((q) => q.governing && q.answer?.trim())) return false;
    return this.governing.settle(questions, signal).then(
      (leftOpen) => leftOpen > 0,
      (err: unknown) => {
        if (!signal?.aborted) {
          log.warn("Governing answers could not be settled — their rules stay uncertain", {
            analysisId,
            error: (err as Error).message,
          });
        }
        return true;
      },
    );
  }

  /**
   * #2016 — the start path's retry of answers whose settle failed, with the
   * per-analysis backoff of {@link orphanRetries}.
   */
  private async retryOrphanedGoverning(
    analysisId: string,
    state: ClarificationState,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const backoff = orphanRetries.get(analysisId);
    if (backoff && Date.now() < backoff.nextAt) return;
    const leftOpen = await this.settleGoverning(analysisId, state, signal);
    // #2022 — an aborted retry neither counts as an attempt nor clears one.
    // #2029 / #2033 — the one place an abort decides the backoff.
    if (signal?.aborted) return;
    orphanRetries.delete(analysisId);
    if (!leftOpen) return;
    const attempts = (backoff?.attempts ?? 0) + 1;
    const wait = Math.min(ORPHAN_RETRY_BASE_MS * 2 ** (attempts - 1), ORPHAN_RETRY_MAX_MS);
    // Re-inserted, so the map's order is the order of the latest backoff.
    orphanRetries.set(analysisId, { attempts, nextAt: Date.now() + wait });
    if (orphanRetries.size > ORPHAN_RETRY_MAX_ENTRIES) {
      orphanRetries.delete(orphanRetries.keys().next().value!);
    }
  }

  /**
   * Start or continue a clarification dialog for an analysis.
   * Returns questions for the current round.
   */
  async startOrContinue(
    analysisId: string,
    requirements: StructuredRequirements,
    signal?: AbortSignal,
  ): Promise<ClarificationState> {
    const existing = await readDialogState(analysisId);
    // Issue #937 — a remounted Questions tab POSTed a second start while the
    // first was still generating, and that second round replaced the first
    // one's questions (and billed question generation twice). A start that
    // arrives while one for the same analysis + round is in flight joins it.
    const key = `${analysisId}:${existing?.currentRound ?? 1}`;
    const inFlight = startsInFlight.get(key);
    if (inFlight) return inFlight;
    const started = this.runStart(analysisId, requirements, existing, signal).finally(() => {
      startsInFlight.delete(key);
    });
    startsInFlight.set(key, started);
    return started;
  }

  private async runStart(
    analysisId: string,
    requirements: StructuredRequirements,
    existing: ClarificationState | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ClarificationState> {
    requirements = withAmbiguityDefaults(requirements);
    let state = existing;

    if (!state) {
      state = {
        analysisId,
        currentRound: 1,
        maxRounds: MAX_ROUNDS,
        rounds: [],
        resolvedAmbiguities: [],
        escalatedToSonnet: false,
        completed: false,
      };
    }

    // #2009 — an answer whose settle failed is retried here, before anything
    // is asked: also on a completed dialog, which asks nothing more. #2016 —
    // backed off per analysis, so a provider outage is not paid per start.
    await this.retryOrphanedGoverning(analysisId, state, signal);

    // #2077 — a dialog already complete is returned as it is: viewing the
    // Questions tab must not rewrite an unchanged row.
    if (state.currentRound > MAX_ROUNDS) {
      if (!state.completed) {
        state.completed = true;
        await writeDialogState(analysisId, state);
      }
      return state;
    }

    // #2068 — a completed dialog with rounds left re-opens for governing
    // questions only: a finding the refresh after an answer left Needs BA
    // input with a new question (which can land after the submit completed
    // the dialog), or one of a dialog completed before #2059 asked them.
    if (state.completed) {
      const reopen = await this.governingQuestionsFor(state, signal);
      // #2077 — nothing to ask leaves the dialog as it was: no write per view.
      // (The orphan retry above records its settlements on the applicability,
      // never on this state.)
      if (reopen.length === 0) return state;
      state.completed = false;
      state.rounds.push({
        round: state.currentRound,
        questions: await this.groundQuestions(reopen, signal),
        answers: [],
      });
      await writeDialogState(analysisId, state);
      log.info("Clarification re-opened for governing questions", {
        analysisId,
        round: state.currentRound,
        questions: reopen.length,
      });
      return state;
    }

    // Issue #937 — the current round has already been generated and is still
    // waiting for answers: return it as-is. Regenerating it would replace the
    // questions the user is looking at (and may be answering) with new ids.
    if (state.rounds.at(-1)?.round === state.currentRound) {
      return state;
    }

    // Filter requirements that still have unaddressed ambiguities.
    //
    // Issue #1117 (finding A) — "addressed", not "resolved". Asking again about
    // a field the user has already answered is the single most visible way to
    // tell them their work did not take, and it happened for 13 of 14 questions
    // in the reported run purely because the resolution model was stingy.
    const addressed = addressedAmbiguities(state);
    const unresolvedReqs = requirements.requirements.filter((r) =>
      r.ambiguities.some((a) => !addressed.has(`${r.id}:${a.field}`)),
    );

    // #1873 — the plain business questions for `uncertain` governing rules
    // join the round. None while the flag is off (no source).
    const governingQuestions = await this.governingQuestionsFor(state, signal);

    if (unresolvedReqs.length === 0 && governingQuestions.length === 0) {
      state.completed = true;
      await writeDialogState(analysisId, state);
      return state;
    }

    const questions =
      unresolvedReqs.length > 0
        ? await this.generateQuestions(unresolvedReqs, state, addressed, signal)
        : [];

    // Self-resolution pass (clarify-self-resolve): before surfacing questions,
    // try to ANSWER each from the project's own ingested knowledge. Only runs
    // when a retriever + projectId are configured and the provider is online.
    // A grounding failure must never break question generation, so the whole
    // pass is wrapped — on error we fall back to the ungrounded questions
    // (each implicitly "open"). #1873 — governing questions go through the same
    // pass: it reads only the project's index, never the governing one.
    const groundedQuestions = await this.groundQuestions(
      [...questions, ...governingQuestions],
      signal,
    );

    const round: ClarificationRound = {
      round: state.currentRound,
      // #1129 — the ticked items' questions lead the round.
      questions: orderQuestionsAskFirst(groundedQuestions, this.askFirst),
      answers: [],
    };

    state.rounds.push(round);
    await writeDialogState(analysisId, state);

    return state;
  }

  /**
   * Submit answers for the current round and process them.
   * Returns updated requirements and dialog state.
   *
   * #1668 — `beforeCommit` runs on the result as part of committing the round.
   * When it throws, the round is left open and can be answered again: the
   * caller persists the requirements there, and refuses (409
   * REQUIREMENTS_REPLACED) without consuming the round.
   *
   * #2101 — the round is committed by compare-and-set on the state this
   * submit read, so of two submits of one open round (two tabs, or a tab and a
   * CSV import) exactly one is written: the other is refused with 409
   * CLARIFY_ROUND_NOT_OPEN before `beforeCommit` runs, so neither its answers
   * nor its refined requirements land. Committed first, then `beforeCommit`;
   * when that throws, the round is put back as it was read.
   */
  async submitAnswers(
    analysisId: string,
    answers: ClarificationAnswer[],
    requirements: StructuredRequirements,
    signal?: AbortSignal,
    beforeCommit?: (result: {
      state: ClarificationState;
      updatedRequirements: StructuredRequirements;
    }) => Promise<void>,
  ): Promise<{ state: ClarificationState; updatedRequirements: StructuredRequirements }> {
    requirements = withAmbiguityDefaults(requirements);
    const read = await readDialogStateRevision(analysisId);
    if (!read) {
      throw new Error(`No clarification dialog found for analysis ${analysisId}`);
    }
    const { state, revision } = read;

    const currentRound = state.rounds[state.rounds.length - 1];
    if (!currentRound) {
      throw new Error("No active round to submit answers to");
    }
    // #2085 — only the latest generated round, while it is still open, takes
    // answers. A client still showing an answered round (the next one is
    // generating, or the dialog completed) or an earlier round (a later one
    // was generated meanwhile) would otherwise write onto the wrong round and
    // bump `currentRound`, which the in-flight start then overwrites: a lost
    // update and a skipped round. Refused before anything is written.
    const roundIds = new Set(currentRound.questions.map((q) => q.id));
    if (
      state.completed ||
      currentRound.round !== state.currentRound ||
      answers.some((a) => !roundIds.has(a.questionId))
    ) {
      throw new AppError(
        409,
        "CLARIFY_ROUND_NOT_OPEN",
        "These answers are for a clarification round that is no longer open. Reload the " +
          "questions and answer the current round.",
      );
    }

    currentRound.answers = answers;
    // Issue #1104 (finding C) — stamp each answer onto its question so the
    // PERSISTED round is self-describing. Previously the answers lived only in
    // `round.answers`, and every consumer that walked `round.questions` (the UI
    // panel, the CSV export) rendered an answered round as an empty form.
    //
    // Issue #1117 (finding A) — and record, in the same pass, which real
    // ambiguities the user actually answered. This happens BEFORE the resolution
    // model is consulted, so a failed or stingy resolution call cannot cost the
    // user credit for work they did.
    const realFieldsByReq = new Map(
      requirements.requirements.map((r) => [r.id, new Set(r.ambiguities.map((a) => a.field))]),
    );
    const answered = new Set(state.answeredAmbiguities ?? []);
    for (const q of currentRound.questions) {
      const submitted = answers.find((a) => a.questionId === q.id);
      if (!submitted || submitted.answer.trim().length === 0) continue;
      q.answer = submitted.answer;
      // Same guard #1104 applies to the model's claims: only a field that is a
      // REAL ambiguity of its requirement may be counted.
      if (realFieldsByReq.get(q.requirementId)?.has(q.ambiguityField)) {
        answered.add(`${q.requirementId}:${q.ambiguityField}`);
      }
    }
    state.answeredAmbiguities = [...answered];

    // Process answers and update requirements
    const updatedRequirements = await this.resolveAmbiguities(state, answers, requirements, signal);

    // Check if we need to escalate to Sonnet
    const totalAmbiguities = requirements.requirements.reduce(
      (sum, r) => sum + r.ambiguities.length,
      0,
    );
    const unresolvedRatio =
      totalAmbiguities > 0 ? 1 - state.resolvedAmbiguities.length / totalAmbiguities : 0;

    if (unresolvedRatio > ESCALATION_THRESHOLD && !state.escalatedToSonnet) {
      log.info(
        "Uncertainty %.0f%% exceeds threshold — escalating to Sonnet",
        unresolvedRatio * 100,
      );
      state.escalatedToSonnet = true;
    }

    state.currentRound++;
    // Issue #1117 (finding A) — complete on what has been ADDRESSED. Gating
    // completion on the resolution model's own tally is what kept re-opening a
    // fully-answered dialog for another round. #1873 — a governing question
    // left unanswered keeps the dialog open: the next round asks it again.
    const governingOpen = currentRound.questions.some((q) => q.governing && !q.answer?.trim());
    if (
      state.currentRound > MAX_ROUNDS ||
      (addressedAmbiguities(state).size >= totalAmbiguities && !governingOpen)
    ) {
      state.completed = true;
    }

    // #2101 — only if no other write landed since this submit read the state.
    const committed = await replaceDialogState(analysisId, revision, state);
    if (committed === null) {
      throw new AppError(
        409,
        "CLARIFY_ROUND_NOT_OPEN",
        "These answers were not saved: this clarification round was answered somewhere " +
          "else at the same time. Reload the questions and answer the current round.",
      );
    }
    try {
      await beforeCommit?.({ state, updatedRequirements });
    } catch (err) {
      // #1668 — a refused commit leaves the round open to answer again.
      const restored = await replaceDialogState(
        analysisId,
        committed,
        JSON.parse(revision) as ClarificationState,
      ).catch(() => null);
      if (restored === null) {
        log.warn("A refused clarification submit could not re-open its round", { analysisId });
      }
      throw err;
    }

    // #1873 — judge the answered governing questions back onto the rules they
    // settle, after the round is committed so a refused submit settles nothing.
    // #2009 — every round's, so an earlier round's failed settle is retried.
    // #2016 — a submit's settle is its own attempt: the next start retries
    // whatever it left open straight away, with a fresh backoff.
    orphanRetries.delete(analysisId);
    await this.settleGoverning(analysisId, state, signal);

    return { state, updatedRequirements };
  }

  /**
   * Get the model to use, considering Sonnet escalation. The Claude tier ids
   * are sent only to a provider that serves them (#532).
   */
  private getModel(state: ClarificationState): string | undefined {
    if (state.escalatedToSonnet) {
      return tierModelFor(this.provider, SONNET_MODEL_ID);
    }
    return this.model ?? tierModelFor(this.provider, HAIKU_MODEL_ID);
  }

  /**
   * Generate clarifying questions for unresolved ambiguities.
   */
  private async generateQuestions(
    requirements: StructuredRequirement[],
    state: ClarificationState,
    /**
     * #1117 (finding A) — the ambiguities not to raise again. Passed in rather
     * than recomputed so the caller's filter and the prompt's summary can never
     * disagree about which fields are still open.
     */
    addressed: Set<string>,
    signal?: AbortSignal,
  ): Promise<ClarifyingQuestion[]> {
    const messages = buildQuestionMessages(requirements, state.currentRound, [...addressed]);
    const model = this.getModel(state);

    // #1081 — one re-prompt, then an ERROR the analyst sees. This used to read an
    // unparseable answer as zero questions and persist an empty round, which the
    // panel showed as "nothing to clarify".
    const outcome = await requestStructuredVerdict(this.provider, {
      label: "clarification-questions",
      schema: questionsEnvelopeSchema,
      schemaName: "clarifying questions",
      expectedShape: QUESTIONS_SHAPE,
      messages,
      model,
      signal,
      disableTools: true,
      responseFormat: jsonObjectWhereDeclared(this.provider, model),
    });
    if (!hasVerdict(outcome)) {
      // A transport failure keeps its own error (and its HTTP mapping), as before.
      if (outcome.reason === "provider-error") throw outcome.cause ?? new Error(outcome.detail);
      log.warn("Clarifying questions could not be read — no round started", {
        reason: outcome.reason,
        attempts: outcome.attempts,
      });
      throw new AppError(
        502,
        "MODEL_REPLY_UNREADABLE",
        "METIS could not read the clarifying questions in the model's answer, so no round was " +
          "started. This does not mean there is nothing to clarify — try again.",
      );
    }
    return toQuestions(outcome.verdict.questions, requirements);
  }

  /**
   * Run the retrieval-grounded self-resolution pass over generated questions.
   *
   * EVERY returned question is guaranteed to carry a defined `groundingStatus`.
   * When grounding is not configured / the provider is offline / the pass
   * errors, the questions are not grounded but are still stamped "open" (the
   * back-compat default) so no question ever surfaces "cold" without a verdict.
   */
  private async groundQuestions(
    questions: ClarifyingQuestion[],
    signal?: AbortSignal,
  ): Promise<ClarifyingQuestion[]> {
    if (!this.retriever || !this.projectId || this.provider.offline) {
      return questions.map((q) => ({ ...q, groundingStatus: q.groundingStatus ?? "open" }));
    }
    try {
      const grounding = new AmbiguityGrounding({
        provider: this.provider,
        retriever: this.retriever,
      });
      return await grounding.groundQuestions(this.projectId, questions, signal);
    } catch (err) {
      log.warn("Self-resolution grounding pass failed — surfacing questions as open", {
        error: (err as Error).message,
      });
      // #1081 — open because the check failed, not because a model said so.
      return questions.map((q) => ({
        ...q,
        groundingStatus: q.groundingStatus ?? "open",
        groundingFailed: true,
      }));
    }
  }

  /**
   * Resolve ambiguities using user answers.
   */
  private async resolveAmbiguities(
    state: ClarificationState,
    answers: ClarificationAnswer[],
    requirements: StructuredRequirements,
    signal?: AbortSignal,
  ): Promise<StructuredRequirements> {
    const lastRound = state.rounds[state.rounds.length - 1];
    if (!lastRound) return requirements;
    // #1873 — a governing question is about the rulebook's reach, not the
    // requirement's wording, and its requirement id is the analysis's, not this
    // list's: its answer is settled by `governing.settle`, never folded into a
    // requirement description here.
    const currentRound = lastRound.questions.some((q) => q.governing)
      ? { ...lastRound, questions: lastRound.questions.filter((q) => !q.governing) }
      : lastRound;

    // Issue #1104 (finding C) — a blank answer is NOT an answer: it must not
    // buy a resolution call, and it must never mark an ambiguity resolved.
    const answerFor = (questionId: string): string | undefined => {
      const submitted = answers.find((a) => a.questionId === questionId)?.answer;
      return submitted && submitted.trim().length > 0 ? submitted : undefined;
    };

    // Build context from Q&A pairs
    const qaPairs = currentRound.questions
      .map((q) => {
        const answer = answerFor(q.id);
        return answer ? `Q: ${q.question}\nA: ${answer}` : null;
      })
      .filter(Boolean)
      .join("\n\n");

    if (!qaPairs) return requirements;

    // Process each requirement that had questions asked
    const affectedReqIds = new Set(currentRound.questions.map((q) => q.requirementId));
    const updatedReqs = [...requirements.requirements];
    // Issue #1104 (finding C) — a SET, so the same field can never be counted
    // twice. The live incident recorded 40 "resolved" entries for 12 real
    // ambiguities, which then drove `totalAmbiguities` to -28.
    const resolved = new Set(state.resolvedAmbiguities);
    /** #1081 — requirements whose resolution answer could not be read. */
    const unreadResolutions: string[] = [];

    for (const reqId of affectedReqIds) {
      const reqIndex = updatedReqs.findIndex((r) => r.id === reqId);
      if (reqIndex === -1) continue;

      const req = updatedReqs[reqIndex]!;
      const reqQuestions = currentRound.questions.filter((q) => q.requirementId === reqId);
      const reqQA = reqQuestions
        .map((q) => {
          const answer = answerFor(q.id);
          return answer ? `Q: ${q.question}\nA: ${answer}` : null;
        })
        .filter(Boolean)
        .join("\n");
      // Nothing was answered for this requirement — there is no basis to
      // resolve anything on it, so don't spend a call asking.
      if (!reqQA) continue;

      // Issue #1104 (finding C) — a field may only be marked resolved when it
      // is a REAL ambiguity of this requirement AND its question was actually
      // answered in this round. The model routinely claims more.
      const realFields = new Set(req.ambiguities.map((a) => a.field));
      const answeredFields = new Set(
        reqQuestions.filter((q) => answerFor(q.id) !== undefined).map((q) => q.ambiguityField),
      );

      const messages = buildResolutionMessages(req, reqQA);

      try {
        const model = this.getModel(state);
        const outcome = await requestStructuredVerdict(this.provider, {
          label: "clarification-resolution",
          schema: resolutionSchema,
          schemaName: "clarification resolution",
          expectedShape: RESOLUTION_SHAPE,
          messages,
          model,
          signal,
          disableTools: true,
          responseFormat: jsonObjectWhereDeclared(this.provider, model),
        });
        if (!hasVerdict(outcome)) {
          // #1081 — the answers are already credited above (answeredAmbiguities),
          // so nothing the user wrote is lost; what did not happen is the rewrite
          // of this requirement's description. Record it on the round so the
          // panel can say so instead of staying silent. A failed call is the
          // same outcome for the analyst, so it is recorded the same way.
          log.warn("Clarification resolution could not be read — description not updated", {
            requirementId: reqId,
            reason: outcome.reason,
          });
          unreadResolutions.push(reqId);
        }
        const resolution = hasVerdict(outcome) ? toResolution(outcome.verdict) : null;
        if (resolution) {
          for (const field of resolution.resolvedFields) {
            if (!realFields.has(field) || !answeredFields.has(field)) {
              log.debug("Ignoring unsupported resolved field", { field, requirementId: reqId });
              continue;
            }
            resolved.add(`${reqId}:${field}`);
          }
          if (resolution.updatedDescription) {
            updatedReqs[reqIndex] = {
              ...req,
              description: resolution.updatedDescription,
            };
          }
        }
      } catch (err) {
        log.warn("Failed to resolve ambiguities", {
          requirementId: reqId,
          error: (err as Error).message,
        });
      }
    }

    state.resolvedAmbiguities = [...resolved];
    // On the stored round, not the governing-free view of it.
    if (unreadResolutions.length > 0) lastRound.unreadResolutions = unreadResolutions;
    else delete lastRound.unreadResolutions;

    // Issue #1104 (finding C) — count what is STILL unresolved on the
    // requirements themselves. The old `total - resolved.length` subtraction
    // went negative the moment the model over-claimed, and a negative
    // `totalAmbiguities` made the UI hide the whole clarification section
    // (`totalAmbiguities > 0` was its render gate), taking the user's answers
    // with it.
    //
    // Issue #1117 (finding A) — an answered ambiguity is no longer outstanding
    // work for the user, so it must not be counted as remaining either.
    const addressed = addressedAmbiguities(state);
    const remaining = updatedReqs.reduce(
      (sum, r) => sum + r.ambiguities.filter((a) => !addressed.has(`${r.id}:${a.field}`)).length,
      0,
    );

    return {
      ...requirements,
      requirements: updatedReqs,
      totalAmbiguities: remaining,
    };
  }

  /**
   * @internal — exposed for testing. #1081 — `null` when the answer cannot be
   * read at all (no JSON object, or no `questions` array); `[]` only for an
   * answer that really lists no questions.
   */
  parseQuestions(content: string): ClarifyingQuestion[] | null {
    let json: unknown;
    try {
      json = extractJsonObject(content);
    } catch {
      return null;
    }
    const envelope = questionsEnvelopeSchema.safeParse(json);
    return envelope.success ? toQuestions(envelope.data.questions) : null;
  }
}

/** #1081 — the envelope only; each question is still read leniently. */
const questionsEnvelopeSchema = z.object({ questions: z.array(z.unknown()) }).refine(
  // #1081 review — questions listed, but not one usable, must not save an empty round.
  (o) => !noUsableItem(o.questions, (q) => toQuestions([q]).length > 0),
  { message: "no questions entry has a question and a requirementId", path: ["questions"] },
);

const QUESTIONS_SHAPE =
  '{ "questions": [ { "requirementId": string, "ambiguityField": string, "question": string, ' +
  '"context": string } ] }';

/**
 * #1081 — the resolution answer. Every field the dialog reads is optional, as
 * before; what is new is that an answer that is not a JSON object at all is
 * re-prompted once and then recorded on the round instead of being dropped
 * without a word.
 */
const resolutionSchema = z.object({
  // #1081 review — the two keys the dialog acts on must be PRESENT (null is a
  // readable "nothing"), so `{}` or snake_case keys are an unread resolution,
  // recorded in `unreadResolutions`, not a silent no-op.
  resolvedFields: z.array(z.unknown()).nullable(),
  updatedDescription: z.string().nullable(),
  remainingUncertainty: z.unknown().optional(),
});

const RESOLUTION_SHAPE =
  '{ "resolvedFields": string[], "updatedDescription": string, "remainingUncertainty": number }';

/**
 * #2128 — an id shorter than this reads as a label a person gave ("REQ-001"),
 * and is left in a question as written; a longer one is a machine id (a UUID,
 * a cuid) that means nothing to the analyst.
 */
const MIN_INTERNAL_ID_CHARS = 16;

/**
 * What may stand around an id. Fixed patterns, matched on the few characters
 * beside each occurrence the text search found: no pattern is built from an id.
 */
const ID_ASIDE_OPEN = /\s*\(\s*(?:requirement\s+)?id\s*[:=]?\s*$/i;
const ID_ASIDE_CLOSE = /^\s*\)/;
const ID_LABEL = /\[?(?:\bid\s*[:=]\s*)?$/i;
/** How far before an id its `(id: ` or `[id: ` label is looked for. */
const ID_LABEL_WINDOW = 32;
/**
 * #2132 — text that ends in a "requirement" no other word describes: at the
 * start, after punctuation, or after only an article or a preposition.
 * #2143 — punctuation, not a digit or a quote: "the REQ-001 requirement" and
 * `the "Login" requirement` are named already.
 */
const BARE_REQUIREMENT =
  /(?:^|[^\p{L}\p{N}\s"'“”‘’]\s*|\b(?:the|this|that|a|an|each|for|of|in|on|to|about|with|by|from|and|or)\s+)requirement$/iu;

/**
 * #2143 — whether `text` ends in a bare "requirement", read over the last
 * {@link ID_LABEL_WINDOW} characters only: the question built so far can be
 * long, and only the words just before the aside decide. The window is longer
 * than "requirement", so its start-of-text case still holds only for a text
 * that is the word alone.
 */
function endsInBareRequirement(text: string): boolean {
  return BARE_REQUIREMENT.test(text.slice(-ID_LABEL_WINDOW));
}

/**
 * ASCII-only lower case. `String.prototype.toLowerCase` can change a string's
 * length ("İ" becomes two code units), so an index found in its result would
 * slice the original text in the wrong place. The ids are ASCII, so folding
 * only A-Z finds them just as well and keeps every index valid.
 */
const foldAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** `text` with each occurrence of `id` (any case) dropped as an aside, or replaced by `"title"`. */
function replaceId(text: string, id: string, title: string): string {
  const needle = foldAscii(id);
  let out = "";
  let rest = text;
  for (let at = foldAscii(rest).indexOf(needle); at !== -1;) {
    const before = rest.slice(0, at);
    const after = rest.slice(at + id.length);
    const near = before.slice(-ID_LABEL_WINDOW);
    const lead = before.length - near.length;
    const open = ID_ASIDE_OPEN.exec(near);
    const close = ID_ASIDE_CLOSE.exec(after);
    if (open && close) {
      const kept = before.slice(0, lead + open.index);
      // #2132 — "Requirement (id: X) is unclear." loses its referent without
      // the aside: a bare "requirement" is named by the quoted title instead.
      out += endsInBareRequirement(out + kept) ? `${kept} "${title}"` : kept;
      rest = after.slice(close[0].length);
    } else {
      // ID_LABEL matches at least the empty string at the end. #2132 — its
      // `[` is taken only with the `]` that closes it ("[id: X ]"), so "[X,
      // other]" keeps both brackets rather than a stray `]`.
      const label = ID_LABEL.exec(near)!;
      const bracketClose = /^\s*\]/.exec(after);
      const takesBracket = label[0].startsWith("[") && bracketClose !== null;
      const labelAt = lead + label.index + (label[0].startsWith("[") && !takesBracket ? 1 : 0);
      out += `${before.slice(0, labelAt)}"${title}"`;
      rest = takesBracket ? after.slice(bracketClose[0].length) : after;
    }
    at = foldAscii(rest).indexOf(needle);
  }
  return out + rest;
}

/**
 * #2128 — `text` with the machine ids of `requirements` taken out. The
 * question prompt labels each requirement `(id: …)` so the reply can say which
 * one a question is about, and the model copied that label into the question
 * it wrote: "…the new password length requirement (id: 6280ae21-…)". An
 * `(id: …)` aside is dropped, since the words before it already name the
 * requirement (#2132: after a bare "requirement", which names none, the title
 * takes its place); any other mention becomes the requirement's quoted title. Ids
 * the prompt did not show, and short readable ones, are left as written.
 */
export function nameRequirementIds(
  text: string,
  requirements: readonly Pick<StructuredRequirement, "id" | "title">[],
): string {
  let out = text;
  for (const r of requirements) {
    if (r.id.length < MIN_INTERNAL_ID_CHARS || !out.toLowerCase().includes(r.id.toLowerCase())) {
      continue;
    }
    out = replaceId(out, r.id, r.title);
  }
  return out;
}

/**
 * Read each question leniently; one without a question or requirement is
 * dropped. #2128 — the question and its context name no machine id of
 * `requirements`, the ones the prompt showed ({@link nameRequirementIds});
 * the readability checks pass none.
 */
function toQuestions(
  raw: unknown[],
  requirements: readonly Pick<StructuredRequirement, "id" | "title">[] = [],
): ClarifyingQuestion[] {
  return raw
    .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
    .map((q) => ({
      id: randomUUID(),
      requirementId: typeof q.requirementId === "string" ? q.requirementId : "",
      ambiguityField: typeof q.ambiguityField === "string" ? q.ambiguityField : "",
      question: nameRequirementIds(typeof q.question === "string" ? q.question : "", requirements),
      context: nameRequirementIds(typeof q.context === "string" ? q.context : "", requirements),
    }))
    .filter((q) => q.question && q.requirementId);
}

/** Read a validated resolution answer into the shape the dialog applies. */
function toResolution(json: z.infer<typeof resolutionSchema>): {
  resolvedFields: string[];
  updatedDescription: string;
  remainingUncertainty: number;
} {
  return {
    resolvedFields: (json.resolvedFields ?? []).filter((f): f is string => typeof f === "string"),
    updatedDescription: typeof json.updatedDescription === "string" ? json.updatedDescription : "",
    remainingUncertainty:
      typeof json.remainingUncertainty === "number" ? json.remainingUncertainty : 1,
  };
}
