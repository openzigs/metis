/**
 * Clarification Dialog System (Epic #597 / Issue #624).
 *
 * Generates clarifying questions from requirement ambiguities,
 * supports multi-turn dialog (up to 3 rounds), and escalates from
 * Haiku to Sonnet when uncertainty exceeds a threshold.
 */
import { randomUUID } from "node:crypto";
import type { AIProvider, ChatMessage } from "../ai/types.js";
import { HAIKU_MODEL_ID, SONNET_MODEL_ID } from "../ai/model-router.js";
import { createChildLogger } from "../logger.js";
import { AmbiguityGrounding, type GroundingRetriever } from "./ambiguity-grounding.js";
import {
  deleteDialogState,
  readDialogState,
  writeDialogState,
} from "./clarification-dialog-store.js";
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

export const MAX_ROUNDS = 3;
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
}

export class ClarificationDialog {
  private readonly provider: AIProvider;
  private readonly model: string | undefined;
  private readonly retriever: GroundingRetriever | undefined;
  private readonly projectId: string | undefined;

  constructor(deps: ClarificationDialogDeps) {
    this.provider = deps.provider;
    this.model = deps.model;
    this.retriever = deps.retriever;
    this.projectId = deps.projectId;
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
    let state = await readDialogState(analysisId);

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

    if (state.completed || state.currentRound > MAX_ROUNDS) {
      state.completed = true;
      await writeDialogState(analysisId, state);
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

    if (unresolvedReqs.length === 0) {
      state.completed = true;
      await writeDialogState(analysisId, state);
      return state;
    }

    const questions = await this.generateQuestions(unresolvedReqs, state, addressed, signal);

    // Self-resolution pass (clarify-self-resolve): before surfacing questions,
    // try to ANSWER each from the project's own ingested knowledge. Only runs
    // when a retriever + projectId are configured and the provider is online.
    // A grounding failure must never break question generation, so the whole
    // pass is wrapped — on error we fall back to the ungrounded questions
    // (each implicitly "open").
    const groundedQuestions = await this.groundQuestions(questions, signal);

    const round: ClarificationRound = {
      round: state.currentRound,
      questions: groundedQuestions,
      answers: [],
    };

    state.rounds.push(round);
    await writeDialogState(analysisId, state);

    return state;
  }

  /**
   * Submit answers for the current round and process them.
   * Returns updated requirements and dialog state.
   */
  async submitAnswers(
    analysisId: string,
    answers: ClarificationAnswer[],
    requirements: StructuredRequirements,
    signal?: AbortSignal,
  ): Promise<{ state: ClarificationState; updatedRequirements: StructuredRequirements }> {
    const state = await readDialogState(analysisId);
    if (!state) {
      throw new Error(`No clarification dialog found for analysis ${analysisId}`);
    }

    const currentRound = state.rounds[state.rounds.length - 1];
    if (!currentRound) {
      throw new Error("No active round to submit answers to");
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
    // fully-answered dialog for another round.
    if (state.currentRound > MAX_ROUNDS || addressedAmbiguities(state).size >= totalAmbiguities) {
      state.completed = true;
    }

    await writeDialogState(analysisId, state);

    return { state, updatedRequirements };
  }

  /**
   * Get the model to use, considering Sonnet escalation.
   */
  private getModel(state: ClarificationState): string | undefined {
    if (state.escalatedToSonnet) {
      return SONNET_MODEL_ID;
    }
    return this.model ?? HAIKU_MODEL_ID;
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

    const response = await this.provider.chat(messages, {
      model: this.getModel(state),
      signal,
      disableTools: true,
    });

    return this.parseQuestions(response.content);
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
      return questions.map((q) => ({ ...q, groundingStatus: q.groundingStatus ?? "open" }));
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
    const currentRound = state.rounds[state.rounds.length - 1];
    if (!currentRound) return requirements;

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
        const response = await this.provider.chat(messages, {
          model: this.getModel(state),
          signal,
          disableTools: true,
        });

        const resolution = this.parseResolution(response.content);
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

  /** @internal — exposed for testing */
  parseQuestions(content: string): ClarifyingQuestion[] {
    try {
      const cleaned = content.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const json = JSON.parse(cleaned) as { questions?: unknown[] };
      if (!Array.isArray(json.questions)) return [];

      return json.questions
        .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
        .map((q) => ({
          id: randomUUID(),
          requirementId: typeof q.requirementId === "string" ? q.requirementId : "",
          ambiguityField: typeof q.ambiguityField === "string" ? q.ambiguityField : "",
          question: typeof q.question === "string" ? q.question : "",
          context: typeof q.context === "string" ? q.context : "",
        }))
        .filter((q) => q.question && q.requirementId);
    } catch {
      log.warn("Failed to parse questions response");
      return [];
    }
  }

  private parseResolution(
    content: string,
  ): { resolvedFields: string[]; updatedDescription: string; remainingUncertainty: number } | null {
    try {
      const cleaned = content.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const json = JSON.parse(cleaned) as Record<string, unknown>;
      return {
        resolvedFields: Array.isArray(json.resolvedFields)
          ? json.resolvedFields.filter((f): f is string => typeof f === "string")
          : [],
        updatedDescription:
          typeof json.updatedDescription === "string" ? json.updatedDescription : "",
        remainingUncertainty:
          typeof json.remainingUncertainty === "number" ? json.remainingUncertainty : 1,
      };
    } catch {
      return null;
    }
  }
}
