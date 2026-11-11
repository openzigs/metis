/**
 * #2229 — scoring one arm's reading of one document against its labels.
 *
 * The judge (a model call, {@link judgeReading}) says which labelled
 * requirement each extracted requirement states and, for each question,
 * which labelled ambiguity it asks about and whether a reviewer would want it
 * asked. Everything else is computed here, in code:
 *
 *   - **requirement recall**: labelled requirements some extracted one states;
 *   - **requirement precision**: extracted requirements that state a labelled
 *     one not already claimed (a repeat is not a second hit, and counts
 *     against precision: the analyst reads it twice);
 *   - **section coverage**: of the sections holding a labelled requirement,
 *     the share from which at least one was found;
 *   - **question precision**: questions the judge says are worth asking;
 *   - **ambiguity recall**: labelled ambiguities some question asks about;
 *   - **quote accuracy**: where an arm quotes its source, the share of
 *     requirement quotes found in the document verbatim (whitespace aside).
 */
import type { AIProvider } from "../../ai/types.js";
import { resolveFinalAnswerMaxOutputTokens } from "../../analysis/agent-runner.js";
import { hasVerdict, requestStructuredVerdict } from "../../analysis/structured-verdict.js";
import { clauseLocator } from "../../governing/clause-verify.js";
import type { ArmOutput } from "./arms.js";
import type { FrdLabels } from "./corpus-source.js";
import type { DocUnderstandingItem } from "./corpus.js";
import {
  JUDGE_REPLY_SHAPE,
  buildJudgePrompt,
  judgeReplySchema,
  type JudgeReply,
} from "./prompts.js";

/** The judge's reading, keyed by position: `requirements[i]` grades extracted requirement i. */
export interface Judgement {
  requirements: Array<string | null>;
  questions: Array<{ ambiguity: string | null; worthAsking: boolean }>;
  /** Grades the judge gave for an E/Q it was not shown, or ids not in the labels. */
  invalid: number;
  /** E/Q items the judge left ungraded (scored as no match / not worth asking). */
  ungraded: number;
}

export interface DocScore {
  labelled: number;
  extracted: number;
  matched: number;
  repeats: number;
  requirementRecall: number;
  requirementPrecision: number | null;
  labelledSections: number;
  coveredSections: number;
  sectionCoverage: number;
  /** Labelled sections from which nothing was found, in document order. */
  missedSections: string[];
  questions: number;
  worthAsking: number;
  questionPrecision: number | null;
  ambiguities: number;
  ambiguitiesRaised: number;
  ambiguityRecall: number | null;
  /** Labelled requirements nothing stated. */
  missedRequirements: string[];
  /** Labelled ambiguities no question asked about. */
  missedAmbiguities: string[];
  /**
   * Extracted requirements the judge matched to no label: noise, or a label
   * the corpus is missing. What a reviewer of the labels reads first.
   */
  unmatchedExtracted: string[];
  quoted: number;
  quotesVerified: number;
  quoteAccuracy: number | null;
}

/** Read the judge's reply into a positional {@link Judgement}, discarding what it cannot mean. */
export function readJudgement(
  reply: JudgeReply,
  labels: Pick<FrdLabels, "requirements" | "ambiguities">,
  counts: { extracted: number; questions: number },
): Judgement {
  const reqIds = new Set(labels.requirements.map((r) => r.id));
  const ambIds = new Set(labels.ambiguities.map((a) => a.id));
  const requirements = new Array<string | null>(counts.extracted).fill(null);
  const questions = Array.from({ length: counts.questions }, () => ({
    ambiguity: null as string | null,
    worthAsking: false,
  }));
  const seenE = new Set<number>();
  const seenQ = new Set<number>();
  let invalid = 0;
  const index = (raw: string, prefix: "E" | "Q", size: number): number | null => {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(raw.trim());
    if (!m) return null;
    const i = Number(m[1]) - 1;
    return i >= 0 && i < size ? i : null;
  };
  for (const g of reply.requirements) {
    const i = index(g.extracted, "E", counts.extracted);
    if (i === null || seenE.has(i)) {
      invalid++;
      continue;
    }
    seenE.add(i);
    const label = g.label?.trim() ?? null;
    if (label !== null && label !== "" && label.toLowerCase() !== "null") {
      if (reqIds.has(label)) requirements[i] = label;
      else invalid++;
    }
  }
  for (const g of reply.questions) {
    const i = index(g.question, "Q", counts.questions);
    if (i === null || seenQ.has(i)) {
      invalid++;
      continue;
    }
    seenQ.add(i);
    const amb = g.ambiguity?.trim() ?? null;
    let ambiguity: string | null = null;
    if (amb !== null && amb !== "" && amb.toLowerCase() !== "null") {
      if (ambIds.has(amb)) ambiguity = amb;
      else invalid++;
    }
    questions[i] = { ambiguity, worthAsking: g.worthAsking };
  }
  const ungraded = counts.extracted - seenE.size + (counts.questions - seenQ.size);
  return { requirements, questions, invalid, ungraded };
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

/** Score one reading. Pure: the judge's grades are an input. */
export function scoreReading(
  item: Pick<DocUnderstandingItem, "text" | "labels">,
  output: Pick<ArmOutput, "requirements" | "questions">,
  judgement: Judgement,
): DocScore {
  const { labels } = item;
  const claimed = new Set<string>();
  let repeats = 0;
  for (const label of judgement.requirements) {
    if (label === null) continue;
    if (claimed.has(label)) repeats++;
    else claimed.add(label);
  }
  const sectionOf = new Map(labels.requirements.map((r) => [r.id, r.section]));
  const labelledSections = [...new Set(labels.requirements.map((r) => r.section))];
  const covered = new Set([...claimed].map((id) => sectionOf.get(id)!));
  const raised = new Set(
    judgement.questions.map((q) => q.ambiguity).filter((a): a is string => a !== null),
  );
  const worthAsking = judgement.questions.filter((q) => q.worthAsking).length;
  const locate = clauseLocator(item.text);
  const quotes = output.requirements.map((r) => r.quote?.trim() ?? "").filter(Boolean);
  const verified = quotes.filter((q) => locate(q) !== null).length;
  return {
    labelled: labels.requirements.length,
    extracted: output.requirements.length,
    matched: claimed.size,
    repeats,
    requirementRecall: claimed.size / labels.requirements.length,
    requirementPrecision: ratio(claimed.size, output.requirements.length),
    labelledSections: labelledSections.length,
    coveredSections: covered.size,
    sectionCoverage: covered.size / labelledSections.length,
    missedSections: labelledSections.filter((s) => !covered.has(s)),
    questions: output.questions.length,
    worthAsking,
    questionPrecision: ratio(worthAsking, output.questions.length),
    ambiguities: labels.ambiguities.length,
    ambiguitiesRaised: raised.size,
    ambiguityRecall: ratio(raised.size, labels.ambiguities.length),
    missedRequirements: labels.requirements.filter((r) => !claimed.has(r.id)).map((r) => r.id),
    missedAmbiguities: labels.ambiguities.filter((a) => !raised.has(a.id)).map((a) => a.id),
    unmatchedExtracted: output.requirements
      .filter((_r, i) => (judgement.requirements[i] ?? null) === null)
      .map((r) => r.text),
    quoted: quotes.length,
    quotesVerified: verified,
    quoteAccuracy: ratio(verified, quotes.length),
  };
}

/** Ask the judge to grade one reading. Throws when it gives no usable reply. */
export async function judgeReading(
  provider: AIProvider,
  item: Pick<DocUnderstandingItem, "title" | "text" | "labels">,
  output: Pick<ArmOutput, "requirements" | "questions">,
): Promise<Judgement> {
  const counts = { extracted: output.requirements.length, questions: output.questions.length };
  if (counts.extracted === 0 && counts.questions === 0) {
    return { requirements: [], questions: [], invalid: 0, ungraded: 0 };
  }
  const prompt = buildJudgePrompt({
    title: item.title,
    text: item.text,
    labels: item.labels,
    extracted: output.requirements.map((r) => r.text),
    questions: output.questions.map((q) => q.text),
  });
  const outcome = await requestStructuredVerdict(provider, {
    label: "doc-understanding-judge",
    schema: judgeReplySchema,
    schemaName: "judgement",
    expectedShape: JUDGE_REPLY_SHAPE,
    systemMessage: prompt.systemMessage,
    messages: [{ role: "user", content: prompt.userMessage }],
    disableTools: true,
    maxTokens: resolveFinalAnswerMaxOutputTokens(provider.model, provider.key),
  });
  if (!hasVerdict(outcome)) throw new Error(`judge: no usable reply (${outcome.reason})`);
  return readJudgement(outcome.verdict, item.labels, counts);
}
