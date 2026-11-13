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
 *     citation WITH lines is checked by the judge against the span's text
 *     (lines that are not in the file support nothing); one without lines has
 *     no span to read, so it counts as supporting only when its file is one of
 *     the question's expected sources. Each citation records which check it
 *     got, and an arm reports the two checks apart (#2265): an arm that cites
 *     no lines is graded only by the looser file check, so one blended rate
 *     would compare two different tests;
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

/**
 * How a citation was checked:
 *
 *   - `span`: it gave lines, and the judge read them;
 *   - `no-such-lines`: it gave lines that are not in the file, so there was no
 *     span to show the judge and it supports nothing;
 *   - `file`: it gave no lines, so it supports only when its file is expected.
 */
export type CitationCheck = "span" | "no-such-lines" | "file";

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
  /** Over both checks, for one reply: each citation carries the check it got. */
  citationPrecision: number | null;
  expectedFiles: string[];
  citedExpectedFiles: string[];
  citationRecall: number | null;
}

/**
 * Score one reply. `spanIndex` maps each citation (by position in `citations`)
 * to the span numbers the judge was shown, for the citations that had lines:
 * one per product whose file holds them (a shared path can name several), and
 * none when no file does. A citation supports its claim when any of its spans
 * does.
 */
export function scoreQuestion(
  q: BaQaQuestion,
  citations: readonly Citation[],
  spanIndex: ReadonlyMap<number, readonly number[]>,
  verdict: JudgeVerdict | null,
): QuestionScore {
  const expectedFiles = q.expect === "answer" ? expectedSourceFiles(q) : [];
  const isExpected = (c: Citation): boolean =>
    expectedFiles.some((key) => {
      const i = key.indexOf(":");
      return citesFile(c, key.slice(0, i), key.slice(i + 1));
    });

  const scored: ScoredCitation[] | null = verdict
    ? citations.map((c, i): ScoredCitation => {
        const ns = spanIndex.get(i);
        if (ns === undefined) return { ...c, check: "file", supports: isExpected(c) };
        if (ns.length === 0) return { ...c, check: "no-such-lines", supports: false };
        return { ...c, check: "span", supports: ns.some((n) => verdict.spans[n] === true) };
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
  /**
   * Micro, answer questions only: supporting citations over the citations that
   * gave lines, judged on the span's text (lines not in the file count, as
   * unsupported).
   */
  citationPrecisionLines: Rate;
  /**
   * Micro, answer questions only: citations without lines whose file is an
   * expected source, over all citations without lines. A looser test than the
   * span's, so never blended with it.
   */
  citationPrecisionFile: Rate;
  /** Micro: expected files cited over expected files. */
  citationRecall: Rate;
  /** How many citations had a span the judge read, over all citations. */
  spanChecked: Rate;
  /** Unanswerable questions answered "the sources don't show this". */
  abstention: Rate;
  /** Ambiguous questions met with a follow-up question. */
  followUp: Rate;
  /** Answer questions the reply abstained on. */
  falseAbstention: Rate;
  /** Answer questions the reply asked a follow-up question about instead. */
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
  const withLines = answerCitations.filter((c) => c.check !== "file");
  const fileOnly = answerCitations.filter((c) => c.check === "file");
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
    citationPrecisionLines: rate(withLines.filter((c) => c.supports).length, withLines.length),
    citationPrecisionFile: rate(fileOnly.filter((c) => c.supports).length, fileOnly.length),
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

/**
 * #2269 — the scored turn of one multi-turn question, as each retrieval mode
 * found it. Recorded for every multi-turn question whatever the run's mode:
 * the other mode's searches cost no model call, only local ones.
 */
export interface TurnRetrieval {
  questionId: string;
  /** The fixture's label: the turn leans on the earlier ones. */
  refersBack: boolean;
  /** Production's planner read the turn as a follow-up (it ran a conversational search). */
  followUpDetected: boolean;
  /** The question's expected source files, `<product>:<path>`. */
  expected: string[];
  /** Those among the excerpts conversation-aware retrieval listed, searched or carried. */
  conversation: string[];
  /** Those among the excerpts a search of the new message alone listed. */
  lastMessage: string[];
  /** Excerpts the previous answer cited that came back on this turn. */
  carried: number;
}

export interface RetrievalSummary {
  turns: number;
  /** Micro: expected files the conversation-aware excerpts held, over expected files. */
  conversation: Rate;
  /** The same for a search of the new message alone. */
  lastMessage: Rate;
  /** Turns labelled as referring back that the planner read as follow-ups. */
  followUpsDetected: Rate;
  /** Self-contained controls the planner read as follow-ups anyway. */
  controlsReadAsFollowUps: Rate;
  /** Questions whose conversation-aware excerpts held more expected files, and fewer. */
  better: string[];
  worse: string[];
  /** Excerpts carried forward, over every turn. */
  carried: number;
}

export function summarizeRetrieval(turns: readonly TurnRetrieval[]): RetrievalSummary {
  const sum = (f: (t: TurnRetrieval) => number): number => turns.reduce((a, t) => a + f(t), 0);
  const expected = sum((t) => t.expected.length);
  const refers = turns.filter((t) => t.refersBack);
  const controls = turns.filter((t) => !t.refersBack);
  return {
    turns: turns.length,
    conversation: rate(
      sum((t) => t.conversation.length),
      expected,
    ),
    lastMessage: rate(
      sum((t) => t.lastMessage.length),
      expected,
    ),
    followUpsDetected: rate(refers.filter((t) => t.followUpDetected).length, refers.length),
    controlsReadAsFollowUps: rate(
      controls.filter((t) => t.followUpDetected).length,
      controls.length,
    ),
    better: turns
      .filter((t) => t.conversation.length > t.lastMessage.length)
      .map((t) => t.questionId),
    worse: turns
      .filter((t) => t.conversation.length < t.lastMessage.length)
      .map((t) => t.questionId),
    carried: sum((t) => t.carried),
  };
}
