/**
 * #2230 (Epic #2227) — the document reader: the model reads a parsed business
 * document in order and lists its statements, each labelled
 * (`STATEMENT_KINDS`) and cited to the exact span of the source it rests on.
 *
 * Two modes, chosen by whether the document fits the model's window
 * ({@link chooseReadingMode}):
 *
 *   - **whole** — #2229 measured this: the whole document read at once found
 *     every labelled requirement (recall 1.00, precision 0.93 on Sonnet 5.5)
 *     where today's ten retrieved chunks found 26%. It also showed the limit:
 *     one reply cannot hold every requirement of a 35 KB document. So every
 *     call carries the whole document and asks for the statements of one
 *     batch of sections ({@link READER_BATCH_CHARS} of source), and the reply
 *     stays small however long the document is.
 *     The document and the system message are cached across those calls
 *     (#2262), and a document over {@link READER_WHOLE_MAX_DOCUMENT_TOKENS} is
 *     read sectioned instead, so the cost stops growing with its square.
 *   - **sectioned** — a document too long for the window. One call builds the
 *     document context (purpose, scope, actors, glossary) from the outline of
 *     every section and as much of the text as fits; every batch of sections
 *     is then read with that context, each section under its heading path.
 *
 * Then one cross-section pass over the statements (not the document) names
 * repeats, which are dropped, and cross-references, which are kept.
 *
 * Every statement passes the governing rule reader's deterministic check
 * before it is kept: its quote must be in the source verbatim, whitespace
 * aside (`clauseLocator`), and the stored quote and offsets are the source's
 * own. A statement that fails is dropped and counted, never kept with an
 * invented citation.
 *
 * Nothing is cut silently: the coverage report ({@link SectionCoverage}) lists
 * every section with what was read from it, a section that produced nothing
 * says so, and a batch whose reply could not be read is reported `unread`.
 * A provider error or a cancellation fails the read (the caller's agent fails
 * as it would today); a read in which no batch could be read throws
 * {@link DocumentReaderError}.
 */
import type { AIProvider, TokenUsage } from "../ai/types.js";
import { resolveFinalAnswerMaxOutputTokens } from "../analysis/agent-runner.js";
import { estimateTokens } from "../analysis/context-window-manager.js";
import { resolveContextWindow } from "../analysis/context-watermark.js";
import {
  hasVerdict,
  requestStructuredVerdict,
  type StructuredVerdictOutcome,
} from "../analysis/structured-verdict.js";
import { clauseLocator } from "../governing/clause-verify.js";
import {
  DOCUMENT_CONTEXT_SHAPE,
  MERGE_REPLY_SHAPE,
  STATEMENTS_REPLY_SHAPE,
  buildDocumentContextPrompt,
  buildMergePrompt,
  buildSectionBatchPrompt,
  buildWholeDocumentBatchPrompt,
  documentContextSchema,
  mergeReplySchema,
  rawStatementSchema,
  statementsReplySchema,
  type DocumentContext,
  type StatementKind,
} from "./prompts.js";
import { batchSections, outlineSections, sectionAt, type ReaderSection } from "./sections.js";

/**
 * #2280 — the reader's version, part of a saved reading's key
 * (`reading-cache.ts`). Bump it when the reader's prompts, reply schemas,
 * batching or verification change: every saved reading is then read again.
 */
export const READER_VERSION = "2230.1";

/** Source characters whose statements one reply is asked to write. */
export const READER_BATCH_CHARS = 8000;
/** The share of the model's window a reading call may fill, reply included. */
export const READER_WINDOW_SHARE = 0.8;
/** Tokens allowed for the instructions and section markers around the document. */
export const READER_PROMPT_OVERHEAD_TOKENS = 2000;
/** The least opening text the sectioned mode's context call is given. */
const MIN_CONTEXT_OPENING_CHARS = 4000;
/**
 * #2262 — the longest document read in whole mode (about 80 KB of text). Every
 * whole-mode call carries the whole document and there is one call per
 * {@link READER_BATCH_CHARS}, so its prompt tokens grow with the square of the
 * document's length; above this a document is read sectioned, whose cost grows
 * in step with it. 80 KB keeps the epic's 60 KB reading in whole mode.
 */
export const READER_WHOLE_MAX_DOCUMENT_TOKENS = 20_000;

export type ReadingMode = "whole" | "sectioned";

export interface ReadStatement {
  /** `T1`, `T2`, ... in document order, after repeats are dropped. */
  id: string;
  kind: StatementKind;
  /** The statement in the model's plain words. */
  statement: string;
  /** The source's own text: `text.slice(start, end)`, never the model's copy. */
  quote: string;
  start: number;
  end: number;
  sectionId: string;
  headingPath: string[];
  /** Ids of statements this one refers to (the cross-section pass). */
  refersTo: string[];
}

export type SectionReadStatus = "read" | "unread";

/** What was read from one section. `statements === 0` on a read section means it produced nothing. */
export interface SectionCoverage {
  sectionId: string;
  headingPath: string[];
  start: number;
  end: number;
  status: SectionReadStatus;
  /** Statements kept from this section, by kind. */
  kinds: Partial<Record<StatementKind, number>>;
  statements: number;
  /** Statements whose quote was not found in this section's source. */
  unverified: number;
  /** Statements dropped as repeats of an earlier one. */
  repeats: number;
}

export interface DocumentReading {
  mode: ReadingMode;
  statements: ReadStatement[];
  sections: SectionCoverage[];
  /** Entries the model returned that could not be kept: no quote found, or malformed. */
  droppedUnverified: number;
  /** Whether the cross-section pass ran (`skipped` with fewer than two statements). */
  merge: "done" | "failed" | "skipped";
  /** Model calls made (a re-prompt counts). */
  calls: number;
  /** The output-token cap every call was given (#2229 finding 4 and 6). */
  outputTokenCap: number;
  usage: TokenUsage;
  /**
   * #2280 — set when this reading was not made now but reused from a saved one
   * (`reading-cache.ts`): when it was read and with which model. A reused
   * reading made no model call, so its `calls` and `usage` are zero.
   */
  reused?: ReadingReuse;
}

/** #2280 — the saved reading a run reused instead of reading the document again. */
export interface ReadingReuse {
  /** When the saved reading was made. */
  readAt: Date;
  /** The model that made it. */
  model: string;
}

export interface ReadDocumentInput {
  title: string;
  /** The parsed document (`parseDocument`'s Markdown). */
  text: string;
  provider: AIProvider;
  /** The model to read with; default the provider's. */
  model?: string;
  signal?: AbortSignal;
  /** Force a mode (the eval harness, tests); default {@link chooseReadingMode}. */
  mode?: ReadingMode;
  /**
   * #2262 (#1237) — the operator's notes for the analysis, given to every
   * statements call as fenced data. They frame the reading, never narrow it.
   */
  operatorNotes?: string;
}

/** No section of the document could be read. Its message is METIS's own, so safe to show. */
export class DocumentReaderError extends Error {
  override name = "DocumentReaderError";
}

const SPENT_USAGE = Symbol.for("metis.documentReader.spentUsage");

/**
 * #2262 — record on a failure the tokens spent before it, so a read that fails
 * on its fifth batch still counts the first four against the monthly cap. The
 * error itself is returned unchanged (an `AbortError` stays one).
 */
export function withSpentUsage<E>(err: E, usage: TokenUsage): E {
  if (typeof err === "object" && err !== null && Object.isExtensible(err)) {
    (err as Record<symbol, unknown>)[SPENT_USAGE] = usage;
  }
  return err;
}

/** The tokens a failed read had spent ({@link withSpentUsage}), or `undefined`. */
export function spentUsageOf(err: unknown): TokenUsage | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  return (err as Record<symbol, TokenUsage | undefined>)[SPENT_USAGE];
}

/**
 * `whole` when the document is at most {@link READER_WHOLE_MAX_DOCUMENT_TOKENS}
 * and it, the prompt and a full reply fit the window's usable share.
 */
export function chooseReadingMode(input: {
  documentTokens: number;
  windowTokens: number;
  outputTokenCap: number;
}): ReadingMode {
  const usable = Math.floor(input.windowTokens * READER_WINDOW_SHARE);
  return input.documentTokens <= READER_WHOLE_MAX_DOCUMENT_TOKENS &&
    input.documentTokens + READER_PROMPT_OVERHEAD_TOKENS + input.outputTokenCap <= usable
    ? "whole"
    : "sectioned";
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}

interface Kept {
  kind: StatementKind;
  statement: string;
  quote: string;
  start: number;
  end: number;
  section: ReaderSection;
}

/**
 * Read `input.text` and list its labelled, verified statements with a coverage
 * report. A failure carries the tokens already spent ({@link spentUsageOf}).
 */
export async function readDocument(input: ReadDocumentInput): Promise<DocumentReading> {
  const meter = { usage: ZERO_USAGE, calls: 0 };
  try {
    return await read(input, meter);
  } catch (err) {
    throw withSpentUsage(err, meter.usage);
  }
}

async function read(
  input: ReadDocumentInput,
  meter: { usage: TokenUsage; calls: number },
): Promise<DocumentReading> {
  const { provider, text } = input;
  const model = input.model ?? provider.model;
  const outputTokenCap = resolveFinalAnswerMaxOutputTokens(model, provider.key);
  const windowTokens = resolveContextWindow(provider.key, model).tokens;
  const sections = outlineSections(text);
  const mode =
    input.mode ??
    chooseReadingMode({ documentTokens: estimateTokens(text), windowTokens, outputTokenCap });

  const ask = async <T>(
    label: string,
    prompt: { systemMessage: string; userMessage: string; cachePrefix?: string },
    schema: Parameters<typeof requestStructuredVerdict<T>>[1]["schema"],
    expectedShape: string,
  ): Promise<StructuredVerdictOutcome<T>> => {
    const outcome = await requestStructuredVerdict(provider, {
      label,
      schema,
      schemaName: label,
      expectedShape,
      systemMessage: prompt.systemMessage,
      messages: [{ role: "user", content: prompt.userMessage }],
      disableTools: true,
      maxTokens: outputTokenCap,
      // #2262 — every batch call of one document shares the system message and
      // the user message's lead (the whole document, in whole mode): cache them.
      ...(prompt.cachePrefix
        ? { promptCaching: { system: true, userPrefix: prompt.cachePrefix } }
        : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    meter.usage = addUsage(meter.usage, outcome.usage);
    meter.calls += outcome.attempts;
    return outcome;
  };
  /** A provider failure fails the read; any other unreadable reply is the caller's to report. */
  const rethrowProviderError = (outcome: StructuredVerdictOutcome<unknown>): void => {
    if (!hasVerdict(outcome) && outcome.reason === "provider-error") {
      throw outcome.cause instanceof Error ? outcome.cause : new Error(outcome.detail);
    }
  };

  const coverage = new Map<string, SectionCoverage>(
    sections.map((s) => [
      s.id,
      {
        sectionId: s.id,
        headingPath: s.headingPath,
        start: s.start,
        end: s.end,
        status: "read",
        kinds: {},
        statements: 0,
        unverified: 0,
        repeats: 0,
      },
    ]),
  );

  // Sectioned mode reads each batch with the document context, built once.
  let context: DocumentContext | null = null;
  let batchChars = READER_BATCH_CHARS;
  if (mode === "sectioned") {
    const usableTokens =
      Math.floor(windowTokens * READER_WINDOW_SHARE) -
      outputTokenCap -
      READER_PROMPT_OVERHEAD_TOKENS;
    const outlineChars = sections.reduce((n, s) => n + s.headingPath.join(" › ").length + 8, 0);
    const openingChars = Math.max(MIN_CONTEXT_OPENING_CHARS, usableTokens * 4 - outlineChars);
    batchChars = Math.max(1, Math.min(READER_BATCH_CHARS, usableTokens * 4));
    const outcome = await ask(
      "document-reader-context",
      buildDocumentContextPrompt({
        title: input.title,
        sections,
        opening: text.slice(0, openingChars),
        openingIsWhole: openingChars >= text.length,
      }),
      documentContextSchema,
      DOCUMENT_CONTEXT_SHAPE,
    );
    rethrowProviderError(outcome);
    // Without a context the sections are still read, each under its heading path.
    context = hasVerdict(outcome)
      ? outcome.verdict
      : { purpose: input.title, scope: "", actors: [], glossary: [] };
  }

  const locate = clauseLocator(text);
  const kept: Kept[] = [];
  const seen = new Set<string>();
  let droppedUnverified = 0;
  let readBatches = 0;
  const batches = batchSections(sections, batchChars);
  for (const batch of batches) {
    const outcome = await ask(
      "document-reader-statements",
      context
        ? buildSectionBatchPrompt({
            title: input.title,
            context,
            batch,
            operatorNotes: input.operatorNotes,
          })
        : buildWholeDocumentBatchPrompt({
            title: input.title,
            sections,
            batch,
            operatorNotes: input.operatorNotes,
          }),
      statementsReplySchema,
      STATEMENTS_REPLY_SHAPE,
    );
    rethrowProviderError(outcome);
    if (!hasVerdict(outcome)) {
      for (const s of batch) coverage.get(s.id)!.status = "unread";
      continue;
    }
    readBatches++;
    const inBatch = new Map(batch.map((s) => [s.id, s]));
    const batchSpan = { start: batch[0]!.start, end: batch[batch.length - 1]!.end };
    for (const entry of outcome.verdict.statements) {
      const parsed = rawStatementSchema.safeParse(entry);
      if (!parsed.success) {
        droppedUnverified++;
        continue;
      }
      const named = inBatch.get(parsed.data.section.trim().toUpperCase());
      // #2262 — `clauseLocator`'s span is a preference: with no occurrence in it,
      // it returns the first in the whole text. A quote from outside the batch
      // would be attributed to a section this call was not asked about, so it
      // counts as unverified. One the named section lacks but another section of
      // the batch holds is kept.
      let clause = locate(parsed.data.quote, named ?? batchSpan);
      if (named && clause && !startsIn(clause, named))
        clause = locate(parsed.data.quote, batchSpan);
      if (!clause || !startsIn(clause, batchSpan)) {
        droppedUnverified++;
        coverage.get((named ?? batch[0]!).id)!.unverified++;
        continue;
      }
      const section = sectionAt(sections, clause.clauseStart) ?? batch[0]!;
      const key = `${clause.clauseStart}:${clause.clauseEnd}:${parsed.data.statement.replace(/\s+/g, " ").toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push({
        kind: parsed.data.kind,
        statement: parsed.data.statement,
        quote: clause.clauseExcerpt,
        start: clause.clauseStart,
        end: clause.clauseEnd,
        section,
      });
    }
  }
  if (batches.length > 0 && readBatches === 0) {
    throw new DocumentReaderError(
      `The model's replies for "${input.title}" could not be read, so none of its ${sections.length} sections was read.`,
    );
  }

  kept.sort((a, b) => a.start - b.start || a.end - b.end);
  const draftIds = kept.map((_k, i) => `T${i + 1}`);

  // The cross-section pass: repeats and cross-references.
  const dropped = new Set<number>();
  const refs = new Map<number, Set<number>>();
  let merge: DocumentReading["merge"] = "skipped";
  if (kept.length >= 2) {
    const outcome = await ask(
      "document-reader-merge",
      buildMergePrompt({
        title: input.title,
        statements: kept.map((k, i) => ({
          id: draftIds[i]!,
          kind: k.kind,
          section: k.section.id,
          statement: k.statement,
        })),
      }),
      mergeReplySchema,
      MERGE_REPLY_SHAPE,
    );
    // A failed merge keeps every statement: a repeat read twice costs less than a requirement lost.
    if (hasVerdict(outcome)) {
      merge = "done";
      const indexOf = new Map(draftIds.map((id, i) => [id, i]));
      for (const d of outcome.verdict.duplicates) {
        const i = indexOf.get(d.id.toUpperCase());
        const of = indexOf.get(d.of.toUpperCase());
        if (i === undefined || of === undefined || of >= i || dropped.has(of)) continue;
        dropped.add(i);
        coverage.get(kept[i]!.section.id)!.repeats++;
      }
      for (const r of outcome.verdict.crossReferences) {
        const from = indexOf.get(r.from.toUpperCase());
        const to = indexOf.get(r.to.toUpperCase());
        if (from === undefined || to === undefined || from === to) continue;
        if (!refs.has(from)) refs.set(from, new Set());
        refs.get(from)!.add(to);
      }
    } else {
      merge = "failed";
    }
  }

  const finalId = new Map<number, string>();
  kept.forEach((_k, i) => {
    if (!dropped.has(i)) finalId.set(i, `T${finalId.size + 1}`);
  });
  const statements: ReadStatement[] = [];
  kept.forEach((k, i) => {
    const id = finalId.get(i);
    if (!id) return;
    const cov = coverage.get(k.section.id)!;
    cov.statements++;
    cov.kinds[k.kind] = (cov.kinds[k.kind] ?? 0) + 1;
    statements.push({
      id,
      kind: k.kind,
      statement: k.statement,
      quote: k.quote,
      start: k.start,
      end: k.end,
      sectionId: k.section.id,
      headingPath: k.section.headingPath,
      // A reference to a dropped repeat points at nothing kept, so it goes.
      refersTo: [...(refs.get(i) ?? [])].flatMap((to) => {
        const target = finalId.get(to);
        return target ? [target] : [];
      }),
    });
  });

  return {
    mode,
    statements,
    sections: [...coverage.values()],
    droppedUnverified,
    merge,
    calls: meter.calls,
    outputTokenCap,
    usage: meter.usage,
  };
}

function startsIn(clause: { clauseStart: number }, span: { start: number; end: number }): boolean {
  return clause.clauseStart >= span.start && clause.clauseStart < span.end;
}
