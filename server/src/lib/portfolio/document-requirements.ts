/**
 * #2272 (Epic #2227) — the requirements a portfolio check reads from a
 * document, and what it could not check of them.
 *
 * Before this an FRD was one requirement: its text cut at 8,000 characters,
 * split into at most 8 criteria and searched on its first 4,000. Now the check
 * reads the document as Impact Analysis does (#2231):
 *
 *   1. the stored file, parsed (`loadImpactDocumentText`), else its stored
 *      chunks with their overlap removed;
 *   2. with the document reader on (`ANALYSIS_DOCUMENT_READER`), the model
 *      reads it in full (`document-reader/reader.ts`, #2230) and each
 *      requirement, constraint or business rule it finds is one requirement to
 *      check, with the section it sits in. Off, or when the reading fails, the
 *      splitter Impact Analysis keeps for that case makes one per paragraph or
 *      bullet (`shapeAwareChangeExtractor`), and the statement says so;
 *   3. each requirement is one criterion of the check (the gap engine judges
 *      them in groups, each searched on its own).
 *
 * Nothing is cut silently: a requirement past {@link PORTFOLIO_MAX_REQUIREMENTS},
 * the characters of one past {@link PORTFOLIO_REQUIREMENT_MAX_CHARS}, a section
 * the model could not read and the statements it dropped (their quote is not in
 * the document) are each returned in `notChecked`, which the check stores.
 */
import {
  PORTFOLIO_MAX_REQUIREMENTS,
  PORTFOLIO_REQUIREMENT_MAX_CHARS,
  type PortfolioNotChecked,
} from "@metis/shared";
import type { ChangeExtractor } from "../impact-analysis/extract-changes.js";
import { loadImpactDocumentText, type ReadStoredFile } from "../impact-analysis/document-source.js";
import type { DocumentReading } from "../document-reader/reader.js";
import { REQUIREMENT_STATEMENT_KINDS } from "../document-reader/prompts.js";
import { formatHeadingPath } from "../document-reader/sections.js";

type DocumentPrisma = Parameters<typeof loadImpactDocumentText>[0];

/** The model reading a document, and what the reading cost. */
export type PortfolioDocumentReader = (input: {
  title: string;
  text: string;
}) => Promise<{ reading: DocumentReading; costUsd: number }>;

export interface DocumentRequirementsDeps {
  prisma: DocumentPrisma;
  storage: ReadStoredFile;
  /** The model reader; absent when the document reader is off. */
  reader?: PortfolioDocumentReader;
  /** The splitter for when there is no reader, or the reading failed. */
  extractor: ChangeExtractor;
}

export interface DocumentRequirements {
  /** The check's statement: which document, and how its requirements were found. */
  statement: string;
  /** Each requirement to check, in document order. */
  criteria: string[];
  notChecked: PortfolioNotChecked[];
  /** What the model reading cost (0 without one). */
  costUsd: number;
}

/** Entries of one kind listed one by one; past this the rest are counted in one entry. */
export const NOT_CHECKED_LISTED_PER_REASON = 200;
/** Characters of a cut text's opening that name it in the not-checked list. */
const CUT_OPENING_CHARS = 200;
const TITLE_CHARS = 200;

/** The document has no requirement the check could read. Its message is METIS's own. */
export class NoDocumentRequirementsError extends Error {
  override name = "NoDocumentRequirementsError";
}

function oneLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Requirement texts as criteria: each cut to what one may hold, and only so
 * many; everything cut is returned in `notChecked`, never dropped silently.
 * Shared with a check started from one requirement (its acceptance criteria).
 */
export function boundedRequirements(texts: readonly string[]): {
  criteria: string[];
  notChecked: PortfolioNotChecked[];
} {
  const notChecked: PortfolioNotChecked[] = [];
  const kept = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  const criteria = kept.slice(0, PORTFOLIO_MAX_REQUIREMENTS).map((t) => {
    const cut = cutText(t, PORTFOLIO_REQUIREMENT_MAX_CHARS);
    if (cut.entry) notChecked.push(cut.entry);
    return cut.text;
  });
  const over = kept.slice(PORTFOLIO_MAX_REQUIREMENTS);
  notChecked.push(
    ...listed(
      over.map((t) => oneLine(t, PORTFOLIO_REQUIREMENT_MAX_CHARS)),
      "over-limit",
      (n) => `${n} more requirements`,
    ),
  );
  return { criteria, notChecked };
}

/**
 * `text` cut to `max` characters, and (when it was) the not-checked entry
 * saying how many characters were left out, named by its opening.
 */
export function cutText(
  text: string,
  max: number,
): { text: string; entry: PortfolioNotChecked | null } {
  if (text.length <= max) return { text, entry: null };
  return {
    text: text.slice(0, max),
    entry: { text: oneLine(text, CUT_OPENING_CHARS), reason: "text-cut", count: text.length - max },
  };
}

/** One entry per text up to {@link NOT_CHECKED_LISTED_PER_REASON}, then one counting the rest. */
function listed(
  texts: readonly string[],
  reason: PortfolioNotChecked["reason"],
  more: (n: number) => string,
): PortfolioNotChecked[] {
  const shown = texts.slice(0, NOT_CHECKED_LISTED_PER_REASON);
  const rest = texts.length - shown.length;
  return [
    ...shown.map((text) => ({ text, reason, count: null })),
    ...(rest > 0 ? [{ text: more(rest), reason, count: rest }] : []),
  ];
}

/** The requirements the reader found, each with the section it sits in. */
function fromReading(reading: DocumentReading): {
  texts: string[];
  notChecked: PortfolioNotChecked[];
} {
  const texts = reading.statements
    .filter((s) => REQUIREMENT_STATEMENT_KINDS.has(s.kind))
    .map((s) => {
      const where = formatHeadingPath(s.headingPath).trim();
      return where ? `${s.statement} (section: ${where})` : s.statement;
    });
  const notChecked = listed(
    reading.sections
      .filter((s) => s.status === "unread")
      .map((s) => oneLine(formatHeadingPath(s.headingPath), PORTFOLIO_REQUIREMENT_MAX_CHARS)),
    "section-unread",
    (n) => `${n} more sections`,
  );
  if (reading.droppedUnverified > 0) {
    notChecked.push({
      text: "Statements the model read",
      reason: "quote-not-found",
      count: reading.droppedUnverified,
    });
  }
  return { texts, notChecked };
}

function statementFor(title: string, how: string, found: number): string {
  const head = `Requirements read from "${oneLine(title, TITLE_CHARS)}"`;
  const each = `${found} ${found === 1 ? "requirement" : "requirements"}`;
  const over = found - PORTFOLIO_MAX_REQUIREMENTS;
  const tail =
    over > 0
      ? `The first ${PORTFOLIO_MAX_REQUIREMENTS} are each checked on their own; the other ${over} are listed as not checked.`
      : found === 1
        ? "It is checked on its own."
        : "Each is checked on its own.";
  // Bounded by construction (a title of at most 200 characters): no cut is made.
  return `${head}: ${how} found ${each}. ${tail}`;
}

/**
 * The requirements of document `documentId` for a portfolio check. Throws
 * {@link NoDocumentRequirementsError} when the document has no text, or none
 * of its text reads as a requirement. A provider error or a cancellation of
 * the model reading falls back to the splitter; the statement says so.
 */
export async function requirementsFromDocument(
  documentId: string,
  deps: DocumentRequirementsDeps,
): Promise<DocumentRequirements> {
  const doc = await loadImpactDocumentText(deps.prisma, documentId, deps.storage);
  if (doc.text.trim().length === 0) {
    throw new NoDocumentRequirementsError("The document has no text to read.");
  }
  let texts: string[] | null = null;
  let readNotChecked: PortfolioNotChecked[] = [];
  let costUsd = 0;
  let how = "the splitter (one per paragraph or bullet; the document reader is off)";
  if (deps.reader) {
    try {
      const { reading, costUsd: cost } = await deps.reader({ title: doc.title, text: doc.text });
      costUsd = cost;
      ({ texts, notChecked: readNotChecked } = fromReading(reading));
      how = "the model read it in full and";
    } catch {
      how =
        "the model could not read it, so the splitter (one per paragraph or bullet; one requirement may be several)";
    }
  }
  if (texts === null) {
    texts = (await deps.extractor.extract(doc.text)).map((c) => c.body || c.title);
  }
  const { criteria, notChecked } = boundedRequirements(texts);
  if (criteria.length === 0) {
    throw new NoDocumentRequirementsError("No requirement was found in the document.");
  }
  return {
    statement: statementFor(doc.title, how, texts.filter((t) => t.trim().length > 0).length),
    criteria,
    notChecked: [...readNotChecked, ...notChecked],
    costUsd,
  };
}
