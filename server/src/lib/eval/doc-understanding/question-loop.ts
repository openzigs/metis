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
 *      (the provider's Haiku tier where it serves one, `getModel`), then
 *      `selectQuestionsToAsk` sets aside the unanswerable and the
 *      same-whichever-way, ranks the rest and asks at most
 *      `MAX_QUESTIONS_PER_ROUND`; when it asks nothing while ambiguities are
 *      open, the open ambiguities are asked as written (`fallbackQuestionsFor`).
 *
 * What an analysis does around that and the eval does not: no governing
 * questions (`GOVERNING_DOCS_ENABLED` off), no answers reused from earlier
 * analyses (a fresh project), no ticked items to ask first, and no search for
 * answers in the project's knowledge (it holds only this document). Only the
 * first round is measured: later rounds need the analyst's answers.
 */
import { ambiguityKeys } from "@metis/shared";
import { randomUUID } from "node:crypto";
import type { AIProvider } from "../../ai/types.js";
import { HAIKU_MODEL_ID, tierModelFor } from "../../ai/model-router.js";
import { generateClarifyingQuestions } from "../../analysis/clarification-dialog.js";
import { fallbackQuestionsFor } from "../../analysis/question-ambiguity-match.js";
import {
  citationFor,
  selectQuestionsToAsk,
  type QuestionSelection,
} from "../../analysis/question-selection.js";
import {
  RequirementsExtractor,
  buildSourceExtractionInput,
  type SourceStatement,
} from "../../analysis/requirements-extractor.js";
import type { ClarifyingQuestion } from "../../analysis/types/requirements.js";
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
    /** Questions the model wrote that were filed under an open ambiguity. */
    questionsGenerated: number;
    setAsideUnanswerable: number;
    setAsideSameOutcome: number;
    /** Worth asking but past the round's cap: left for the next round. */
    overCap: number;
    /** 1 when nothing was worth asking and the open ambiguities were asked as written. */
    fallback: number;
    questionsAsked: number;
  };
}

const NONE_ASKED: Omit<FirstRound["diagnostics"], "sourceStatements"> = {
  structuredRequirements: 0,
  ambiguities: 0,
  questionsGenerated: 0,
  setAsideUnanswerable: 0,
  setAsideSameOutcome: 0,
  overCap: 0,
  fallback: 0,
  questionsAsked: 0,
};

/**
 * The first round of clarifying questions an analysis asks about `reading`.
 * `model` is the analysis's model, which production gives the extraction
 * (`new RequirementsExtractor({ provider, model: input.model })`); the question
 * call stays at the dialog's own model.
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
  const open = requirements.filter((r) => r.ambiguities.length > 0);
  if (open.length === 0) {
    return { asked: [], diagnostics: { ...NONE_ASKED, ...counts } };
  }
  const generated = await generateClarifyingQuestions(provider, {
    requirements: open,
    round: 1,
    addressed: new Set(),
    sourceQuestions: true,
    model: tierModelFor(provider, HAIKU_MODEL_ID),
  });
  const priorities = new Map(requirements.map((r) => [r.id, r.priority]));
  const priorityOf = (id: string) => priorities.get(id);
  let selection: QuestionSelection = selectQuestionsToAsk(generated, { priorityOf });
  const setAside = selection.setAside;
  let fallback = 0;
  if (selection.ask.length === 0) {
    // As `runStart`: only a set-aside question about a REAL ambiguity closes
    // it (the #1104 guard); what is still open is asked as written.
    const real = new Set(requirements.flatMap((r) => ambiguityKeys(r)));
    const addressed = new Set(
      setAside.map((q) => `${q.requirementId}:${q.ambiguityField}`).filter((key) => real.has(key)),
    );
    const byId = new Map(requirements.map((r) => [r.id, r]));
    const cited = fallbackQuestionsFor(requirements, addressed, randomUUID).map((q) => {
      const citation = citationFor(byId.get(q.requirementId), q.ambiguityField);
      return citation ? { ...q, citation } : q;
    });
    if (cited.length > 0) {
      fallback = 1;
      selection = selectQuestionsToAsk(cited, { priorityOf });
    }
  }
  return {
    asked: selection.ask,
    diagnostics: {
      ...counts,
      questionsGenerated: generated.length,
      setAsideUnanswerable: setAside.filter((q) => q.reason === "unanswerable").length,
      setAsideSameOutcome: setAside.filter((q) => q.reason === "same-outcome").length,
      overCap: selection.notAsked.length,
      fallback,
      questionsAsked: selection.ask.length,
    },
  };
}
