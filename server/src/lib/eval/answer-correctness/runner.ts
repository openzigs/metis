/**
 * Epic #1316 / Issue #1319 — the answer-correctness run.
 *
 * Thin by design: load the corpus's reference answers, pair each with the answer
 * the system produced for that query, score both directions, and fold into the
 * `eval-results/` envelope. The interesting decisions live in `reference.ts`
 * (what counts as valid ground truth) and `metric.ts` (what counts as correct).
 *
 * Two rules are enforced here and nowhere else:
 *
 * 1. **A query with no gold answer is NOT SCORED.** Pairing a generated answer
 *    with nothing and calling the result 0 would make "we have not written the
 *    ground truth yet" indistinguishable from "the system is wrong", which is
 *    exactly the confusion #1319 exists to end.
 * 2. **A `FLAG:` item is not scored either.** It is a report that the corpus
 *    query is unanswerable from its anchored span; scoring it would blame the
 *    system for a defect in `queries.json`. It is carried into the envelope as a
 *    corpus finding instead.
 */
import type { ScoreAnswerCorrectnessDeps } from "./metric.js";
import {
  correctnessEnvelope,
  scoreAnswerCorrectness,
  type AnswerCorrectness,
  type CorrectnessEnvelope,
} from "./metric.js";
import {
  flaggedFindings,
  loadReferenceSet,
  REFERENCE_FILENAME,
  scorableAnswers,
  type ReferenceSet,
  type ValidateReferenceOptions,
} from "./reference.js";

/** The system's answer for one query. */
export interface GeneratedAnswer {
  queryId: string;
  answer: string;
}

/**
 * Score every query that carries a gold answer.
 *
 * Sequential: each query costs two claim decompositions and two entailment
 * batches, and a whole corpus fanned out at once is a thundering herd against
 * the provider.
 */
export async function scoreReferenceSet(
  set: ReferenceSet,
  generated: readonly GeneratedAnswer[],
  deps: ScoreAnswerCorrectnessDeps,
): Promise<AnswerCorrectness[]> {
  const byId = new Map(generated.map((g) => [g.queryId, g.answer]));
  const out: AnswerCorrectness[] = [];
  for (const ref of scorableAnswers(set)) {
    const answer = byId.get(ref.queryId);
    // No generated answer for a query we have gold for: the SYSTEM produced
    // nothing, which `scoreAnswerCorrectness` records as unverifiable rather
    // than as a zero. That distinction survives into the envelope.
    out.push(
      await scoreAnswerCorrectness(
        { queryId: ref.queryId, answer: answer ?? "", reference: ref.answer },
        deps,
      ),
    );
  }
  return out;
}

export interface RunAnswerCorrectnessInput {
  corpusId: string;
  corpusDir: string;
  /** Pre-computed answers. Ignored when {@link generate} is supplied. */
  generated?: readonly GeneratedAnswer[];
  /**
   * Produce the answers, given the query ids that actually carry gold (#1338).
   *
   * Called ONLY when the corpus has scorable gold answers — generation ingests a
   * corpus and makes one model call per query, and doing that for a reference
   * set nothing can be compared against is the exact waste #1338 exists to
   * prevent. Its laziness is the point; `generated` is the eager form.
   */
  generate?: (queryIds: readonly string[]) => Promise<readonly GeneratedAnswer[]>;
  deps: ScoreAnswerCorrectnessDeps;
  /**
   * Set when {@link deps} is NOT provider-backed, to the reason why (#1338).
   * It takes precedence over every other "no number" explanation: without a
   * judge nothing can be scored however many answers were generated, so naming
   * a downstream cause instead would send an author to fix the wrong thing.
   */
  judgeUnavailable?: string;
  validate?: ValidateReferenceOptions;
}

/**
 * Load a corpus's reference answers and produce the envelope fragment.
 *
 * `absent` and `empty` both yield `reported: false` with a reason, never a
 * number. The generated side is only consulted — or produced — when there is
 * gold to compare it to.
 */
export async function runAnswerCorrectness(
  input: RunAnswerCorrectnessInput,
): Promise<CorrectnessEnvelope> {
  const lookup = await loadReferenceSet(input.corpusDir, input.validate ?? {});
  // The envelope is a persisted artifact under `eval-results/` (and is echoed
  // into the nightly job summary). `lookup.path` is absolute and therefore
  // machine-specific — on a developer's box it embeds a home directory and a
  // username, and on CI the runner's workspace layout. Neither belongs in a
  // published artifact, and neither tells a reader anything the corpus id does
  // not. Report the file by its name within the corpus instead.
  const where = `${input.corpusId}/${REFERENCE_FILENAME}`;
  if (lookup.status === "absent") {
    return correctnessEnvelope({
      corpusId: input.corpusId,
      referenceCount: 0,
      reason: `no ${where} — this corpus has no answer ground truth`,
      reasonCode: "no-reference-file",
    });
  }

  const findings = flaggedFindings(lookup.set);
  const shared = { licensePending: lookup.set.licensePending, findings };

  if (lookup.status === "empty") {
    return correctnessEnvelope({
      corpusId: input.corpusId,
      referenceCount: 0,
      reason:
        `${where} carries no scorable gold answers yet` +
        (findings.length > 0 ? ` (${findings.length} FLAG item(s) are not scorable)` : "") +
        ". Gold answers are authored and reviewed by people (see REFERENCE-AUTHORING.md); " +
        "none has been generated to fill the file, because a model-authored reference would " +
        "make this metric a measurement of the judge against itself.",
      reasonCode: "no-gold-answers",
      ...shared,
    });
  }

  // Gold exists, so it is now worth asking METIS the questions (#1338).
  const goldIds = scorableAnswers(lookup.set).map((a) => a.queryId);
  const generated = input.generate ? await input.generate(goldIds) : (input.generated ?? []);

  const results = await scoreReferenceSet(lookup.set, generated, input.deps);
  const answered = new Set(generated.filter((g) => g.answer.trim() !== "").map((g) => g.queryId));
  const paired = goldIds.filter((id) => answered.has(id)).length;

  // Precedence is deliberate. Without a judge NOTHING is scorable, whatever the
  // generated side did, so that reason is reported first; an author told "no
  // generated answers" would go and fix generation and hit the same wall.
  const notReported =
    input.judgeUnavailable !== undefined
      ? {
          reasonCode: "no-judge" as const,
          reason:
            `${goldIds.length} gold answer(s) and ${paired} generated answer(s) were paired, ` +
            `but ${input.judgeUnavailable} Every score is UNVERIFIABLE — none is a zero.`,
        }
      : paired === 0
        ? {
            reasonCode: "no-generated-answers" as const,
            reason:
              `${where} carries ${goldIds.length} gold answer(s), but METIS produced no answer ` +
              "for any of them — the generated side did not run, so there was nothing to " +
              "compare the gold against. Scores are UNVERIFIABLE, not zero.",
          }
        : undefined;

  return correctnessEnvelope({
    corpusId: input.corpusId,
    referenceCount: results.length,
    results,
    ...(notReported ?? {}),
    ...shared,
  });
}
