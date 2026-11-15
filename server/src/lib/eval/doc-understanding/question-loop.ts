/**
 * #2271 — the clarifying questions an analysis asks first about a document
 * the document reader read (#2235, `ANALYSIS_DOCUMENT_READER` on), for arm R
 * of the document-understanding eval.
 *
 * Production's own steps, in production's order:
 *
 *   1. the reader's requirement, constraint and business-rule statements
 *      become the document agent's `REQ-nnn` requirements, each carrying its
 *      verified paragraph (`runDocumentReaderAgent`);
 *   2. the extraction runs in source mode over them (`runEnhancementPipeline`:
 *      `buildSourceExtractionInput`, `RequirementsExtractor.extract` with the
 *      statements), which applies the INCOSE GtWR R7/R8/R9 and TBD rules to
 *      the paragraphs;
 *   3. the dialog's first round (`ClarificationDialog.runStart`): the
 *      requirements with an open ambiguity are given to
 *      `generateClarifyingQuestions` in source mode, at the dialog's model
 *      (the provider's Haiku tier where it serves one, `getModel`), which
 *      writes questions for at most `QUESTION_CANDIDATES_PER_ROUND` of them
 *      (#2534), then `selectQuestionsToAsk` sets aside the unanswerable and the
 *      same-whichever-way, ranks the rest and asks at most
 *      `MAX_QUESTIONS_PER_ROUND`; when it asks nothing while ambiguities are
 *      open, the open ambiguities are asked as written (`fallbackQuestionsFor`);
 *   4. #2534 — the second round, as the dialog asks it once every question of
 *      the first is answered (counted in the diagnostics, not scored).
 *
 * What an analysis does around that and the eval does not: no governing
 * questions (`GOVERNING_DOCS_ENABLED` off), no answers reused from earlier
 * analyses (a fresh project), no ticked items to ask first, and no search for
 * answers in the project's knowledge (it holds only this document). Only the
 * first round is scored: the second is counted, to show it still runs.
 */
import { ambiguityKeys } from "@metis/shared";
import { randomUUID } from "node:crypto";
import type { AIProvider } from "../../ai/types.js";
import { HAIKU_MODEL_ID, SONNET_MODEL_ID, tierModelFor } from "../../ai/model-router.js";
import {
  ESCALATION_THRESHOLD,
  generateClarifyingQuestions,
} from "../../analysis/clarification-dialog.js";
import { fallbackQuestionsFor } from "../../analysis/question-ambiguity-match.js";
import {
  ambiguitiesToQuestion,
  citationFor,
  selectQuestionsToAsk,
  type QuestionSelection,
} from "../../analysis/question-selection.js";
import {
  RequirementsExtractor,
  buildSourceExtractionInput,
  type SourceStatement,
} from "../../analysis/requirements-extractor.js";
import type {
  ClarifyingQuestion,
  StructuredRequirement,
} from "../../analysis/types/requirements.js";
import { REQUIREMENT_STATEMENT_KINDS } from "../../document-reader/prompts.js";
import type { DocumentReading } from "../../document-reader/reader.js";

/** As `runDocumentReaderAgent` clips a stored requirement's text, quote and headings. */
const MAX_REQUIREMENT_TEXT = 2048;
const MAX_SNIPPET = 2048;
const MAX_HEADING = 512;
const MAX_HEADINGS = 16;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The reader's requirement-like statements as the extraction reads them in an
 * analysis: numbered `REQ-001`, ... in document order, each with its paragraph.
 */
export function sourceStatementsOf(
  reading: Pick<DocumentReading, "statements">,
  document: { documentId: string; filename: string },
): SourceStatement[] {
  return reading.statements
    .filter((s) => REQUIREMENT_STATEMENT_KINDS.has(s.kind))
    .map((s, i) => ({
      ref: `REQ-${String(i + 1).padStart(3, "0")}`,
      documentId: document.documentId,
      filename: clip(document.filename, MAX_HEADING),
      headingPath: s.headingPath.slice(0, MAX_HEADINGS).map((h) => clip(h, MAX_HEADING)),
      quote: clip(s.quote, MAX_SNIPPET),
      statement: clip(s.statement, MAX_REQUIREMENT_TEXT),
    }));
}

export interface FirstRound {
  /** The questions the analyst is asked, in the order asked. */
  asked: ClarifyingQuestion[];
  /** Counts that explain `asked`; every one is present on every round. */
  diagnostics: {
    /** Statements the extraction read. */
    sourceStatements: number;
    /** Requirements the extraction made of them. */
    structuredRequirements: number;
    /** Their ambiguities, the GtWR rules' hits included. */
    ambiguities: number;
    /** #2534 — the open ambiguities the question call wrote questions for. */
    questionCandidates: number;
    /** Questions the model wrote that were filed under an open ambiguity. */
    questionsGenerated: number;
    setAsideUnanswerable: number;
    setAsideSameOutcome: number;
    /** Worth asking but past the round's cap: left for the next round. */
    overCap: number;
    /** 1 when nothing was worth asking and the open ambiguities were asked as written. */
    fallback: number;
    questionsAsked: number;
    /**
     * #2534 — round 2, once every question of round 1 is answered: the
     * ambiguities still open, the questions it wrote and asked, how many it
     * asked about an ambiguity round 1 had addressed (none, by design), and 1
     * when its question call failed.
     */
    secondRoundOpen: number;
    secondRoundGenerated: number;
    secondRoundAsked: number;
    secondRoundRepeats: number;
    secondRoundFailed: number;
  };
}

const NO_SECOND_ROUND = {
  secondRoundOpen: 0,
  secondRoundGenerated: 0,
  secondRoundAsked: 0,
  secondRoundRepeats: 0,
  secondRoundFailed: 0,
};

const NONE_ASKED: Omit<FirstRound["diagnostics"], "sourceStatements"> = {
  structuredRequirements: 0,
  ambiguities: 0,
  questionCandidates: 0,
  questionsGenerated: 0,
  setAsideUnanswerable: 0,
  setAsideSameOutcome: 0,
  overCap: 0,
  fallback: 0,
  questionsAsked: 0,
  ...NO_SECOND_ROUND,
};

/** The keys a round's set-aside questions close: real ambiguities only (the #1104 guard). */
function realSetAsideKeys(
  setAside: QuestionSelection["setAside"],
  requirements: readonly StructuredRequirement[],
): string[] {
  const real = new Set(requirements.flatMap((r) => ambiguityKeys(r)));
  return setAside
    .map((q) => `${q.requirementId}:${q.ambiguityField}`)
    .filter((key) => real.has(key));
}

/**
 * One round as `ClarificationDialog.runStart` asks it, governing questions,
 * reused answers and the search aside: questions for the requirements with an
 * ambiguity not in `addressed`, then `selectQuestionsToAsk`; when that asks
 * nothing while ambiguities are open, the open ambiguities as written.
 */
async function askRound(
  provider: AIProvider,
  requirements: readonly StructuredRequirement[],
  addressed: ReadonlySet<string>,
  round: number,
  model: string | undefined,
) {
  const open = requirements.filter((r) => ambiguityKeys(r).some((k) => !addressed.has(k)));
  const generated = await generateClarifyingQuestions(provider, {
    requirements: open,
    round,
    addressed: new Set(addressed),
    sourceQuestions: true,
    model,
  });
  const priorities = new Map(requirements.map((r) => [r.id, r.priority]));
  const priorityOf = (id: string) => priorities.get(id);
  let selection: QuestionSelection = selectQuestionsToAsk(generated, { priorityOf });
  const setAside = selection.setAside;
  let fallback = 0;
  if (selection.ask.length === 0) {
    // As `runStart`: only a set-aside question about a REAL ambiguity closes
    // it (the #1104 guard); what is still open is asked as written.
    const closed = new Set([...addressed, ...realSetAsideKeys(setAside, requirements)]);
    const byId = new Map(requirements.map((r) => [r.id, r]));
    const cited = fallbackQuestionsFor(requirements, closed, randomUUID).map((q) => {
      const citation = citationFor(byId.get(q.requirementId), q.ambiguityField);
      return citation ? { ...q, citation } : q;
    });
    if (cited.length > 0) {
      fallback = 1;
      selection = selectQuestionsToAsk(cited, { priorityOf });
    }
  }
  return {
    candidates: ambiguitiesToQuestion(open, addressed).size,
    generated: generated.length,
    selection,
    setAside,
    fallback,
  };
}

/**
 * #2534 — round 2 once the analyst has answered every question `first` asked:
 * those ambiguities and the set-aside ones are addressed
 * (`addressedAmbiguities`). Its model is the one the dialog's `getModel` picks
 * then: the Sonnet tier when more than `ESCALATION_THRESHOLD` of the
 * ambiguities are still unresolved (taken at its lowest, every answer resolving
 * its ambiguity), else the Haiku tier. The resolution calls are not made: the
 * question prompt reads the requirements' titles, sources and ambiguities,
 * never the descriptions those calls rewrite. A failed call is counted, never
 * thrown: round 1 stands on its own.
 */
async function askSecondRound(
  provider: AIProvider,
  requirements: readonly StructuredRequirement[],
  first: Awaited<ReturnType<typeof askRound>>,
): Promise<typeof NO_SECOND_ROUND> {
  const real = new Set(requirements.flatMap((r) => ambiguityKeys(r)));
  const answered = first.selection.ask
    .map((q) => `${q.requirementId}:${q.ambiguityField}`)
    .filter((key) => real.has(key));
  const addressed = new Set([...answered, ...realSetAsideKeys(first.setAside, requirements)]);
  const secondRoundOpen = real.size - addressed.size;
  const none = { ...NO_SECOND_ROUND, secondRoundOpen };
  if (secondRoundOpen === 0) return none;
  const escalated = 1 - answered.length / real.size > ESCALATION_THRESHOLD;
  try {
    const second = await askRound(
      provider,
      requirements,
      addressed,
      2,
      tierModelFor(provider, escalated ? SONNET_MODEL_ID : HAIKU_MODEL_ID),
    );
    return {
      ...none,
      secondRoundGenerated: second.generated,
      secondRoundAsked: second.selection.ask.length,
      secondRoundRepeats: second.selection.ask.filter((q) =>
        addressed.has(`${q.requirementId}:${q.ambiguityField}`),
      ).length,
    };
  } catch {
    return { ...none, secondRoundFailed: 1 };
  }
}

/**
 * The first round of clarifying questions an analysis asks about `reading`,
 * and (#2534) the second, counted. `model` is the analysis's model, which
 * production gives the extraction (`new RequirementsExtractor({ provider,
 * model: input.model })`); the question calls stay at the dialog's own model.
 */
export async function askFirstRound(
  provider: AIProvider,
  reading: Pick<DocumentReading, "statements">,
  document: { documentId: string; filename: string },
  opts: { model?: string } = {},
): Promise<FirstRound> {
  const sources = sourceStatementsOf(reading, document);
  if (sources.length === 0) {
    return { asked: [], diagnostics: { sourceStatements: 0, ...NONE_ASKED } };
  }
  const structured = await new RequirementsExtractor({ provider, model: opts.model }).extract(
    buildSourceExtractionInput(sources),
    undefined,
    sources,
  );
  const requirements = structured.requirements;
  const counts = {
    sourceStatements: sources.length,
    structuredRequirements: requirements.length,
    ambiguities: requirements.reduce((n, r) => n + r.ambiguities.length, 0),
  };
  // Round 1: nothing is addressed yet, so a requirement is open when it has an ambiguity.
  if (counts.ambiguities === 0) {
    return { asked: [], diagnostics: { ...NONE_ASKED, ...counts } };
  }
  const first = await askRound(
    provider,
    requirements,
    new Set(),
    1,
    tierModelFor(provider, HAIKU_MODEL_ID),
  );
  const asked = first.selection.ask;
  return {
    asked,
    diagnostics: {
      ...counts,
      questionCandidates: first.candidates,
      questionsGenerated: first.generated,
      setAsideUnanswerable: first.setAside.filter((q) => q.reason === "unanswerable").length,
      setAsideSameOutcome: first.setAside.filter((q) => q.reason === "same-outcome").length,
      overCap: first.selection.notAsked.length,
      fallback: first.fallback,
      questionsAsked: asked.length,
      ...(await askSecondRound(provider, requirements, first)),
    },
  };
}
