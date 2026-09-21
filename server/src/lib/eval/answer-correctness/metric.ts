/**
 * Epic #1316 / Issue #1319 — the answer-correctness metric.
 *
 * ── WHAT IT MEASURES THAT FAITHFULNESS DOES NOT ─────────────────────────────
 *
 * Faithfulness is REFERENCE-FREE: "is this answer supported by what we
 * retrieved?". It is silent on whether the answer is RIGHT. An answer that is
 * confidently wrong but cites real retrieved text scores clean.
 *
 * Answer-correctness compares the generated answer to a HUMAN-AUTHORED reference
 * answer, and is reported SEPARATELY from faithfulness — never blended. The two
 * fail differently, and one number hiding both is one number nobody can act on.
 *
 * ── WHY IT IS SEMANTIC AND NOT LEXICAL ──────────────────────────────────────
 *
 * #1319 requires that "a correct paraphrase must score as correct". A lexical
 * comparison (token F1, ROUGE, substring overlap) fails that by construction —
 * it is the exact defect #1317 removed from `StubRagasJudge`, one metric further
 * on. Embedding cosine was also rejected: METIS's local embedder silently falls
 * back to a hash embedder when Hugging Face is unauthorized, which would yield
 * confident, meaningless similarity scores.
 *
 * So correctness is computed by BIDIRECTIONAL claim entailment, over the same
 * claim-extraction + NLI substrate as the rest of this epic (#1318's
 * `scoreEvidenceFaithfulness`):
 *
 *   recall    = REFERENCE claims entailed by the ANSWER   (nothing omitted)
 *   precision = ANSWER claims entailed by the REFERENCE   (nothing invented)
 *   f1        = harmonic mean of the two — NOT the headline, see below
 *
 * Running both directions matters. Precision alone rewards an answer that says
 * one true thing and omits the rest; recall alone rewards an answer that says
 * everything including three things that are false. RAGAS's `answer_correctness`
 * combines them for exactly this reason.
 *
 * ── THE F1 IS NOT THE HEADLINE (#1342) ──────────────────────────────────────
 *
 * The first real run scored `mean=0.531` at `recall=1.000` over four human gold
 * answers: METIS entailed EVERY claim of every reference. The 0.531 was
 * precision loss, and precision falls whenever METIS's paragraph-length answer
 * carries more TRUE claims than a reference the authoring guide caps at 1–3
 * sentences. F1 counts each of those extra true claims as a miss, so the blended
 * number substantially measures the LENGTH GAP between gold and generated — and
 * `0.531` read as "METIS is 53% correct", which it is not.
 *
 * So the reported shape leads with the two questions that are actually distinct:
 *
 *   recall    — is the answer RIGHT?    (nothing the gold says was omitted)
 *   precision — is the answer FOCUSED?  (nothing was said the gold does not)
 *
 * The harmonic mean is still computed and still emitted, as `f1` / `meanF1`
 * rather than `correctness` / `mean`, and every reported envelope carries an
 * {@link interpretAggregate} caveat, which names the measured claim gap when the
 * run recorded one. See
 * `docs/decisions/0013-answer-correctness-reports-precision-and-recall.md`.
 *
 * ── UNVERIFIABLE IS NOT ZERO ────────────────────────────────────────────────
 *
 * Either direction may come back `null` (offline judge, no claims, unusable
 * verdicts). When either is null the correctness is `null`: an F1 computed from
 * one known and one guessed side is a fabricated number. Nulls are excluded from
 * {@link aggregateCorrectness}'s denominator rather than counted as failures.
 */
import type { ScoreFaithfulnessDeps } from "../../docs-gen/grounding/citation-validator.js";
import {
  scoreEvidenceFaithfulness,
  type FaithfulnessMetric,
  type UnverifiableReason,
} from "../../grounding/faithfulness-metric.js";
import type { CorpusFinding } from "./reference.js";

/**
 * One query's answer-correctness.
 *
 * Field order is the reporting order (#1342): the two questions that mean
 * different things come first, and the blended figure that reads as "percent
 * correct" comes after them, named `f1` rather than `correctness`.
 */
export interface AnswerCorrectness {
  queryId: string;
  /** Fraction of the REFERENCE's claims the answer supports — "is it RIGHT?". */
  recall: number | null;
  /** Fraction of the ANSWER's claims the reference supports — "is it FOCUSED?". */
  precision: number | null;
  /**
   * Harmonic mean of {@link precision} and {@link recall}; `null` if either is.
   * LENGTH-SENSITIVE — see this module's header. Not the headline.
   */
  f1: number | null;
  /**
   * Claims decomposed from the GENERATED answer, and from the REFERENCE.
   *
   * Recorded because the gap between them IS the effect that depresses
   * precision, and a caveat computed from it cannot go stale the way a
   * hand-written sentence can. `0` on an unverifiable row.
   */
  answerClaims: number;
  referenceClaims: number;
  /** Present iff {@link f1} is `null`. */
  unverifiableReason?: UnverifiableReason;
}

/**
 * Harmonic mean, with the degenerate case stated: when both sides are 0 the F1
 * is 0, not NaN. A NaN would serialise to `null` in the committed envelope and
 * be read as "unverifiable" rather than as "wrong".
 * @internal exported for testing.
 */
export function f1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

export interface ScoreAnswerCorrectnessDeps extends ScoreFaithfulnessDeps {
  charBudget?: number;
}

/**
 * Score ONE generated answer against ONE human-authored reference answer.
 *
 * Both directions run against the SAME extractor and judge, so a gap between
 * precision and recall is a fact about the answers rather than about two
 * differently-tuned scorers.
 */
export async function scoreAnswerCorrectness(
  input: { queryId: string; answer: string; reference: string },
  deps: ScoreAnswerCorrectnessDeps,
): Promise<AnswerCorrectness> {
  const answer = input.answer.trim();
  const reference = input.reference.trim();
  const unverifiable = (reason: UnverifiableReason): AnswerCorrectness => ({
    queryId: input.queryId,
    recall: null,
    precision: null,
    f1: null,
    answerClaims: 0,
    referenceClaims: 0,
    unverifiableReason: reason,
  });
  // The system produced nothing: not a wrong answer, an absent one.
  if (!answer) return unverifiable("no-claims");
  // No gold answer to compare against: not measurable, not zero.
  if (!reference) return unverifiable("no-evidence");

  // Precision: treat the REFERENCE as the evidence and ask whether each claim of
  // the ANSWER is entailed by it. Recall: swap the roles. Same substrate, same
  // prompt, opposite direction.
  const [precisionSide, recallSide] = await Promise.all([
    scoreEvidenceFaithfulness(
      `${input.queryId}:precision`,
      answer,
      [{ id: `${input.queryId}:reference`, label: "human reference answer", text: reference }],
      deps,
    ),
    scoreEvidenceFaithfulness(
      `${input.queryId}:recall`,
      reference,
      [{ id: `${input.queryId}:answer`, label: "generated answer", text: answer }],
      deps,
    ),
  ]);

  return buildCorrectness(input.queryId, precisionSide, recallSide);
}

/**
 * Fold the two directional metrics into one correctness. Pure, so the F1 maths
 * and the null propagation are testable without a judge.
 * @internal exported for testing.
 */
export function buildCorrectness(
  queryId: string,
  precisionSide: FaithfulnessMetric,
  recallSide: FaithfulnessMetric,
): AnswerCorrectness {
  const precision = precisionSide.faithfulness;
  const recall = recallSide.faithfulness;
  // The precision side decomposes the ANSWER (judged against the reference as
  // evidence) and the recall side decomposes the REFERENCE. So the totals map
  // the opposite way round from the names of the two directions.
  const answerClaims = precisionSide.totalClaims;
  const referenceClaims = recallSide.totalClaims;
  if (precision === null || recall === null) {
    return {
      queryId,
      recall,
      precision,
      f1: null,
      // An unverifiable row must not contribute a claim count either: a 0/0 pair
      // averaged into the corpus means would make the length gap look smaller
      // than it is, which is the exact reading #1342 exists to stop.
      answerClaims: 0,
      referenceClaims: 0,
      // Name the side that failed, so a run of nulls is diagnosable rather than
      // merely discouraging.
      unverifiableReason:
        (precision === null ? precisionSide.unverifiableReason : recallSide.unverifiableReason) ??
        "judge-unavailable",
    };
  }
  return { queryId, recall, precision, f1: f1(precision, recall), answerClaims, referenceClaims };
}

/**
 * Aggregate over a corpus, in reporting order (#1342).
 *
 * `mean` used to be the first key and the only one anybody quoted. It is now
 * `meanF1`, third, behind the two figures that answer different questions.
 */
export interface CorrectnessAggregate {
  /** Mean recall over the SCORED queries — "is it RIGHT?" — or `null`. */
  meanRecall: number | null;
  /** Mean precision over the SCORED queries — "is it FOCUSED?" — or `null`. */
  meanPrecision: number | null;
  /** Mean harmonic mean. LENGTH-SENSITIVE; never read as "percent correct". */
  meanF1: number | null;
  /** Mean claims per GENERATED answer over the scored queries. */
  meanAnswerClaims: number | null;
  /** Mean claims per REFERENCE answer over the scored queries. */
  meanReferenceClaims: number | null;
  scored: number;
  unverifiable: number;
}

const meanOrNull = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Mean correctness over the queries that produced a number. Unverifiable
 * queries are EXCLUDED from the denominator, never scored 0 — an answer the
 * judge could not evaluate is not a wrong answer.
 */
export function aggregateCorrectness(results: readonly AnswerCorrectness[]): CorrectnessAggregate {
  const scored = results.filter((r) => r.f1 !== null);
  return {
    meanRecall: meanOrNull(scored.map((r) => r.recall as number)),
    meanPrecision: meanOrNull(scored.map((r) => r.precision as number)),
    meanF1: meanOrNull(scored.map((r) => r.f1 as number)),
    meanAnswerClaims: meanOrNull(scored.map((r) => r.answerClaims)),
    meanReferenceClaims: meanOrNull(scored.map((r) => r.referenceClaims)),
    scored: scored.length,
    unverifiable: results.length - scored.length,
  };
}

/**
 * The sentence that has to travel with the number (#1342).
 *
 * The nightly job summary `cat`s the whole envelope, so a caveat that lived only
 * in the console line would not survive the hop to the place people actually
 * read the metric. It is COMPUTED from the aggregate — including the measured
 * claim gap — so it cannot keep asserting a verbosity problem after one stops
 * existing.
 *
 * Returns `null` when nothing was scored: there is no figure to qualify, and the
 * envelope's `reason` is the message in that case.
 */
export function interpretAggregate(aggregate: CorrectnessAggregate): string | null {
  if (aggregate.scored === 0) return null;
  /**
   * The `"n/a"` arm is UNREACHABLE and deliberately kept.
   *
   * `scored === 0` has already returned, and every scored row carries non-null
   * recall/precision/f1 by construction, so no caller can reach it — it exists
   * because the aggregate's fields are `number | null` and a bare `.toFixed`
   * would be a lie about that type. Do not spend a test trying to cover it; it
   * is one of the three branches behind this file's honest branch percentage.
   */
  const n = (v: number | null, dp = 3): string => (v === null ? "n/a" : v.toFixed(dp));
  /**
   * The measured half of the caveat — omitted rather than faked when there is
   * nothing to measure with.
   *
   * Envelopes written before #1342 carry no claim counts, so replaying one
   * yields 0/0, and rendering that as "0.0 claim(s) per answer against 0.0"
   * would state a measurement nobody made. A scored row always decomposes at
   * least one claim on each side (`scoreEvidenceFaithfulness` returns `null`
   * with `no-claims` otherwise), so 0 here means "not recorded", never "none".
   */
  const gap = (agg: CorrectnessAggregate): string => {
    const answer = agg.meanAnswerClaims;
    const reference = agg.meanReferenceClaims;
    if (answer === null || reference === null || answer === 0 || reference === 0) {
      return (
        `this run's claim counts were not recorded, so the size of the gap over its ` +
        `${agg.scored} scored query(ies) is not stated here.`
      );
    }
    return (
      `over these ${agg.scored} scored query(ies) METIS produced ${n(answer, 1)} claim(s) ` +
      `per answer against ${n(reference, 1)} in the gold, so an extra TRUE claim is ` +
      "counted as a miss."
    );
  };
  return (
    `Recall ${n(aggregate.meanRecall)} — the share of the human gold answer's claims METIS ` +
    'entailed; this is the "is the answer RIGHT?" number. ' +
    `Precision ${n(aggregate.meanPrecision)} — the share of METIS's own claims the gold answer ` +
    'entailed; this is "is it FOCUSED?", and it falls whenever METIS is more complete than a ' +
    "reference the authoring guide caps at 1–3 sentences. " +
    `meanF1 ${n(aggregate.meanF1)} blends the two and is LENGTH-SENSITIVE: ${gap(aggregate)} ` +
    'Read meanF1 as a length-aware F1, not "percent correct" (#1342, ADR 0013).'
  );
}

/**
 * Why a run produced no number (#1338).
 *
 * Before #1338 every one of these surfaced as the same sentence, so an author
 * who spent an hour filling `reference.json` and re-ran would hit a second wall
 * with no indication which one. The code is machine-readable and the `reason`
 * that accompanies it is the prose; both are in the committed envelope.
 */
export type NotReportedReason =
  /** The corpus has no `reference.json` at all. */
  | "no-reference-file"
  /** `reference.json` is present but carries no scorable gold answer. */
  | "no-gold-answers"
  /** Gold answers exist, but METIS produced no answer for any of them. */
  | "no-generated-answers"
  /** Both sides exist, but no judge could return a verdict (no provider). */
  | "no-judge";

/**
 * The answer-correctness fragment written to `eval-results/`.
 *
 * `reported: false` is a first-class outcome and the `reason`/{@link reasonCode}
 * pair says which "we have no number" case it is. Emitting `mean: 0` for a
 * corpus with no gold answers would be read as a quality collapse.
 */
export interface CorrectnessEnvelope {
  metric: "answer_correctness";
  corpusId: string;
  reported: boolean;
  reason?: string;
  /** Machine-readable companion to {@link reason}; present iff `!reported`. */
  reasonCode?: NotReportedReason;
  /** Count of SCORABLE gold answers — `FLAG:` items are not among them. */
  referenceCount: number;
  /**
   * True while the reference answers' licence is an OPEN decision (#1322 E4,
   * coupled to #1300). Carried into the envelope so nothing downstream can quote
   * the metric while believing the data under it is settled.
   */
  licensePending?: boolean;
  aggregate?: CorrectnessAggregate;
  /**
   * How {@link aggregate} must be read (#1342). Present iff something was
   * scored, and computed from the run by {@link interpretAggregate} — the
   * envelope is `cat`-ed verbatim into the nightly job summary, so this is what
   * makes the length sensitivity travel to the place the metric is quoted.
   */
  interpretation?: string;
  perQuery?: AnswerCorrectness[];
  /**
   * Queries an author marked `FLAG:` — the anchored `quote` does not answer the
   * question. Excluded from the metric and reported here instead: that is a
   * defect in `queries.json`, not a wrong answer by the system.
   */
  corpusFindings?: CorpusFinding[];
}

export function correctnessEnvelope(input: {
  corpusId: string;
  referenceCount: number;
  results?: readonly AnswerCorrectness[];
  reason?: string;
  reasonCode?: NotReportedReason;
  licensePending?: boolean;
  findings?: readonly CorpusFinding[];
}): CorrectnessEnvelope {
  // Corpus findings are a fact about the CORPUS, so they are reported whether or
  // not there is a score — they are often the only signal an empty run carries.
  const extras = {
    ...(input.licensePending === undefined ? {} : { licensePending: input.licensePending }),
    ...(input.findings && input.findings.length > 0 ? { corpusFindings: [...input.findings] } : {}),
  };
  if (input.referenceCount === 0) {
    return {
      metric: "answer_correctness",
      corpusId: input.corpusId,
      reported: false,
      reason:
        input.reason ??
        "no human-authored reference answers for this corpus yet (see REFERENCE-AUTHORING.md)",
      reasonCode: input.reasonCode ?? "no-gold-answers",
      referenceCount: 0,
      ...extras,
    };
  }
  const results = input.results ?? [];
  const aggregate = aggregateCorrectness(results);
  // Gold answers exist and were paired with something, yet NOTHING produced a
  // number. Reporting `mean: null, reported: true` would put an empty metric on
  // the same footing as a measured one; the run is NOT REPORTED, and the
  // per-query rows stay in the envelope so the unverifiable reasons are
  // readable. They are still nulls, never zeros (#1317's convention).
  if (aggregate.scored === 0) {
    return {
      metric: "answer_correctness",
      corpusId: input.corpusId,
      reported: false,
      reason:
        input.reason ??
        `all ${aggregate.unverifiable} paired answer(s) were UNVERIFIABLE — no score is a zero`,
      reasonCode: input.reasonCode ?? "no-judge",
      referenceCount: input.referenceCount,
      aggregate,
      perQuery: [...results],
      ...extras,
    };
  }
  return {
    metric: "answer_correctness",
    corpusId: input.corpusId,
    reported: true,
    referenceCount: input.referenceCount,
    aggregate,
    // Non-null by construction here: `aggregate.scored === 0` returned above.
    interpretation: interpretAggregate(aggregate) ?? undefined,
    perQuery: [...results],
    ...extras,
  };
}
