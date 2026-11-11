/**
 * #2237 — the question-answering metrics, computed in code from the judge's
 * verdicts and the citations read from each answer.
 *
 * Per question:
 *
 *   - behaviour: what the reply did (answer / follow-up / abstain) and whether
 *     that is what the question expects;
 *   - correctness (answer questions): the share of expected facts the answer
 *     states, and "fully correct" when it states every one and contradicts none;
 *   - citation precision: the share of citations that support the claim. A
 *     citation WITH lines is checked by the judge against the span's text; one
 *     without lines has no span to read, so it counts as supporting only when
 *     its file is one of the question's expected sources. Each citation records
 *     which check it got;
 *   - citation recall (answer questions): the share of the expected source
 *     files the answer cites at all.
 *
 * Per arm: means over the scored questions, micro-averaged citation counts,
 * abstention on unanswerable questions, follow-ups on ambiguous ones, the
 * wrong-behaviour rates on answer questions, and the exact spend.
 *
 * A question the judge could not grade is UNSCORED: it is counted and left out
 * of every rate, never scored as zero.
 */
import { citesFile, type Citation } from "./citations.js";
import type { Behaviour, BaQaQuestion, QuestionCategory } from "./fixture.js";
import { expectedSourceFiles } from "./fixture.js";
import type { JudgeVerdict } from "./judge.js";

export type CitationCheck = "span" | "file";

export interface ScoredCitation extends Citation {
  check: CitationCheck;
  supports: boolean;
}

export interface QuestionScore {
  questionId: string;
  category: QuestionCategory;
  expect: Behaviour;
  /** Null when the judge's reply could not be parsed. */
  behaviour: Behaviour | null;
  behaviourOk: boolean | null;
  facts: { stated: number; contradicted: number; missing: number; total: number } | null;
  factRecall: number | null;
  fullyCorrect: boolean | null;
  citations: ScoredCitation[];
  citationPrecision: number | null;
  expectedFiles: string[];
  citedExpectedFiles: string[];
  citationRecall: number | null;
}

/**
 * Score one reply. `spanIndex` maps each citation (by position in `citations`)
 * to the span number the judge was shown, for the citations that had lines;
 * 0 marks lines that are not in the file, which support nothing.
 */
export function scoreQuestion(
  q: BaQaQuestion,
  citations: readonly Citation[],
  spanIndex: ReadonlyMap<number, number>,
  verdict: JudgeVerdict | null,
): QuestionScore {
  const expectedFiles = q.expect === "answer" ? expectedSourceFiles(q) : [];
  const isExpected = (c: Citation): boolean =>
    expectedFiles.some((key) => {
      const i = key.indexOf(":");
      return citesFile(c, key.slice(0, i), key.slice(i + 1));
    });

  const scored: ScoredCitation[] | null = verdict
    ? citations.map((c, i) => {
        const n = spanIndex.get(i);
        return n !== undefined
          ? { ...c, check: "span" as const, supports: n > 0 && verdict.spans[n] === true }
          : { ...c, check: "file" as const, supports: isExpected(c) };
      })
    : null;

  const cited = expectedFiles.filter((key) => {
    const i = key.indexOf(":");
    return citations.some((c) => citesFile(c, key.slice(0, i), key.slice(i + 1)));
  });

  let facts: QuestionScore["facts"] = null;
  if (verdict && q.facts?.length) {
    const values = q.facts.map((f) => verdict.facts[f.id]);
    facts = {
      stated: values.filter((v) => v === "stated").length,
      contradicted: values.filter((v) => v === "contradicted").length,
      missing: values.filter((v) => v === "missing").length,
      total: values.length,
    };
  }

  return {
    questionId: q.id,
    category: q.category,
    expect: q.expect,
    behaviour: verdict?.behaviour ?? null,
    behaviourOk: verdict ? verdict.behaviour === q.expect : null,
    facts,
    factRecall: facts ? facts.stated / facts.total : null,
    fullyCorrect: facts ? facts.stated === facts.total && facts.contradicted === 0 : null,
    citations: scored ?? citations.map((c) => ({ ...c, check: "file", supports: false })),
    citationPrecision:
      scored && scored.length > 0 ? scored.filter((c) => c.supports).length / scored.length : null,
    expectedFiles,
    citedExpectedFiles: cited,
    citationRecall: expectedFiles.length > 0 ? cited.length / expectedFiles.length : null,
  };
}

/** A rate with its counts: `null` rate when nothing was counted. */
export interface Rate {
  n: number;
  of: number;
  rate: number | null;
}

function rate(n: number, of: number): Rate {
  return { n, of, rate: of > 0 ? n / of : null };
}

function mean(xs: readonly number[]): number | null {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export interface ArmCost {
  /** The chat sessions' spend, ledger-priced. Null when a call was unpriced. */
  answerUsd: number | null;
  /** The judge's spend. */
  judgeUsd: number | null;
}

export interface ArmSummary {
  arm: string;
  questions: number;
  unscored: number;
  /** Answer questions: mean share of facts stated. */
  correctness: number | null;
  fullyCorrect: Rate;
  /** Micro: supporting citations over all citations, answer questions only. */
  citationPrecision: Rate;
  /** Micro: expected files cited over expected files. */
  citationRecall: Rate;
  /** How many citations were checked against a span rather than by file. */
  spanChecked: Rate;
  /** Unanswerable questions answered "the sources don't show this". */
  abstention: Rate;
  /** Ambiguous questions met with a follow-up question. */
  followUp: Rate;
  /** Answer questions the reply abstained on, or asked back about instead. */
  falseAbstention: Rate;
  unneededFollowUp: Rate;
  /** Unanswerable questions given a confident answer anyway. */
  confidentGuess: Rate;
  byCategory: Record<QuestionCategory, { questions: number; behaviourOk: Rate }>;
  cost: {
    answerUsd: number | null;
    judgeUsd: number | null;
    totalUsd: number | null;
    perQuestionUsd: number | null;
  };
}

export function summarizeArm(
  arm: string,
  scores: readonly QuestionScore[],
  cost: ArmCost,
): ArmSummary {
  const scored = scores.filter((s) => s.behaviour !== null);
  const answer = scored.filter((s) => s.expect === "answer");
  const ambiguous = scored.filter((s) => s.expect === "follow-up");
  const unanswerable = scored.filter((s) => s.expect === "abstain");
  const answerCitations = answer.flatMap((s) => s.citations);
  const byCategory = {} as ArmSummary["byCategory"];
  for (const category of [
    "single-product",
    "multi-product",
    "ambiguous",
    "unanswerable",
  ] as const) {
    const all = scores.filter((s) => s.category === category);
    const ok = all.filter((s) => s.behaviourOk !== null);
    byCategory[category] = {
      questions: all.length,
      behaviourOk: rate(ok.filter((s) => s.behaviourOk).length, ok.length),
    };
  }
  const totalUsd =
    cost.answerUsd === null || cost.judgeUsd === null ? null : cost.answerUsd + cost.judgeUsd;
  return {
    arm,
    questions: scores.length,
    unscored: scores.length - scored.length,
    correctness: mean(answer.map((s) => s.factRecall).filter((x): x is number => x !== null)),
    fullyCorrect: rate(answer.filter((s) => s.fullyCorrect).length, answer.length),
    citationPrecision: rate(
      answerCitations.filter((c) => c.supports).length,
      answerCitations.length,
    ),
    citationRecall: rate(
      answer.reduce((a, s) => a + s.citedExpectedFiles.length, 0),
      answer.reduce((a, s) => a + s.expectedFiles.length, 0),
    ),
    spanChecked: rate(
      answerCitations.filter((c) => c.check === "span").length,
      answerCitations.length,
    ),
    abstention: rate(
      unanswerable.filter((s) => s.behaviour === "abstain").length,
      unanswerable.length,
    ),
    followUp: rate(ambiguous.filter((s) => s.behaviour === "follow-up").length, ambiguous.length),
    falseAbstention: rate(answer.filter((s) => s.behaviour === "abstain").length, answer.length),
    unneededFollowUp: rate(answer.filter((s) => s.behaviour === "follow-up").length, answer.length),
    confidentGuess: rate(
      unanswerable.filter((s) => s.behaviour === "answer").length,
      unanswerable.length,
    ),
    byCategory,
    cost: {
      answerUsd: cost.answerUsd,
      judgeUsd: cost.judgeUsd,
      totalUsd,
      perQuestionUsd:
        cost.answerUsd === null || scores.length === 0 ? null : cost.answerUsd / scores.length,
    },
  };
}
