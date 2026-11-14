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
 * Statements cut from one sentence are folded back into one ({@link sentenceSpan}):
 * #2361 measured that most of the reader's repeats were one sentence written as
 * two or three statements, not one statement written twice. Then one
 * cross-section pass over the statements (not the document) names repeats,
 * which are dropped, and cross-references, which are kept. A repeat is the
 * statement that says less, so an overview written before the section that
 * sets a requirement out in full is the one that goes.
 *
 * Every statement passes the governing rule reader's deterministic check
 * before it is kept: its quote must be in the source verbatim, whitespace
 * aside (`clauseLocator`), and the stored quote and offsets are the source's
 * own. A statement that fails is dropped and counted, never kept with an
 * invented citation.
 *
 * Nothing is cut silently: the coverage report ({@link SectionCoverage}) lists
 * every section with what was read from it, a section that produced nothing
 * says so, and a batch whose reply could not be read is reported `unread`. A
 * reply that leaves out a section with text in it is asked again for the
 * sections it left out, and a section still left out is `unread` (#2407).
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
  REQUIREMENT_STATEMENT_KINDS,
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
export const READER_VERSION = "2374.1";

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
  /**
   * Statements dropped as repeats: one the cross-section pass found said in
   * full by another, or one of several cut from the same sentence (#2361).
   */
  repeats: number;
  /**
   * #2361 — sections that hold, in full, a statement dropped from this one as
   * a repeat (an overview set out later), by `sectionId`, each once; through a
   * chain of repeats, the section of the statement finally kept. A section
   * whose every statement went this way was read: its content is there.
   */
  mergedInto?: string[];
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
  const quoted: Kept[] = [];
  let droppedUnverified = 0;
  let readBatches = 0;
  const batches = batchSections(sections, batchChars);
  // #2297 — the shared lead is cached only when a later batch call is planned to
  // read it back: on Anthropic a cache write costs 1.25×. A single batch reads it
  // back only when `requestStructuredVerdict` retries its call with the same
  // prefix (#2321), which is not worth the write on every first call.
  const cacheLead = batches.length > 1;
  /** Ask for the statements of `batch`; `null` when the reply could not be read. */
  const askBatch = async (batch: ReaderSection[]): Promise<unknown[] | null> => {
    const prompt = context
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
        });
    const outcome = await ask(
      "document-reader-statements",
      cacheLead ? prompt : { systemMessage: prompt.systemMessage, userMessage: prompt.userMessage },
      statementsReplySchema,
      STATEMENTS_REPLY_SHAPE,
    );
    rethrowProviderError(outcome);
    return hasVerdict(outcome) ? outcome.verdict.statements : null;
  };
  /** Keep a reply's verified statements; returns the ids of the batch's sections it covered. */
  const keepReply = (batch: ReaderSection[], entries: unknown[]): Set<string> => {
    const covered = new Set<string>();
    const inBatch = new Map(batch.map((s) => [s.id, s]));
    const batchSpan = { start: batch[0]!.start, end: batch[batch.length - 1]!.end };
    for (const entry of entries) {
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
      // #2407 — in one of the batch's own sections: a batch asked again holds
      // only the sections left out, so it need not be contiguous.
      const section = clause ? sectionAt(sections, clause.clauseStart) : undefined;
      if (!clause || !section || !inBatch.has(section.id)) {
        droppedUnverified++;
        coverage.get((named ?? batch[0]!).id)!.unverified++;
        if (named) covered.add(named.id);
        continue;
      }
      covered.add(section.id);
      quoted.push({
        kind: parsed.data.kind,
        statement: parsed.data.statement,
        quote: clause.clauseExcerpt,
        start: clause.clauseStart,
        end: clause.clauseEnd,
        section,
      });
    }
    return covered;
  };
  for (const batch of batches) {
    const entries = await askBatch(batch);
    if (entries === null) {
      for (const s of batch) coverage.get(s.id)!.status = "unread";
      continue;
    }
    readBatches++;
    const covered = keepReply(batch, entries);
    // #2407 — a reply that says nothing of a section with text in it has not
    // read that section (a reply cut short, or an incomplete first draft the
    // model then corrected). Those sections are asked for once more, on their
    // own, and one the second reply leaves out too is reported unread, never read.
    const missing = batch.filter((s) => !covered.has(s.id) && hasBody(s));
    if (missing.length === 0) continue;
    const again = await askBatch(missing);
    const coveredAgain = again === null ? new Set<string>() : keepReply(missing, again);
    for (const s of missing) if (!coveredAgain.has(s.id)) coverage.get(s.id)!.status = "unread";
  }
  if (batches.length > 0 && readBatches === 0) {
    throw new DocumentReaderError(
      `The model's replies for "${input.title}" could not be read, so none of its ${sections.length} sections was read.`,
    );
  }

  quoted.sort((a, b) => a.start - b.start || a.end - b.end);
  const kept = foldSentences(text, quoted, (k) => coverage.get(k.section.id)!.repeats++);
  const draftIds = kept.map((_k, i) => `T${i + 1}`);

  // The cross-section pass: repeats and cross-references.
  const dropped = new Set<number>();
  /** A dropped repeat -> the statement it repeats, which may itself be dropped. */
  const keptAs = new Map<number, number>();
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
      const pairs = outcome.verdict.duplicates.flatMap((d) => {
        const i = indexOf.get(d.id.toUpperCase());
        const of = indexOf.get(d.of.toUpperCase());
        return i === undefined || of === undefined || i === of ? [] : [{ i, of }];
      });
      // #2361 review — a statement that several others are named repeats of is a
      // summary combining them (a table of entitlements, a list of notices), not
      // a fuller restatement of any one: each says something it only abridges,
      // so none of them is dropped into it. Measured on 04: two sentences of
      // 6 and 11.2 were dropped as repeats of one summary row each, and lost.
      const absorbs = new Map<number, Set<number>>();
      for (const { i, of } of pairs) absorbs.set(of, (absorbs.get(of) ?? new Set()).add(i));
      for (const { i, of } of pairs) {
        // #2361 — either order: the one named is the one that says less, and an
        // overview comes before the section that sets it out. The statement it
        // repeats must still be kept, so a pair named both ways never drops both.
        // A summary table restates the body, not the other way round: a prose
        // statement is never dropped as a repeat of a table row (measured on 04,
        // where 6's teen DVD rule went into the appendix's entitlement row).
        // #2374 — except rows into prose: a summary table's rows that each
        // restate part of one body sentence are the table's summary of it, not
        // the other way round (02's "documents reminder" and "closed as
        // abandoned" rows, both kept as repeats of one sentence of 6.1). Only
        // a row the sentence actually holds: a prose overview over a detailed
        // table ("notifications when a booking is made or moved") does not
        // say the rows' channels and timings, so its rows keep the guard.
        const rowIntoProse =
          isTableRow(text, kept[i]!.start) &&
          !isTableRow(text, kept[of]!.start) &&
          isHeldBy(kept[i]!.quote, kept[of]!.quote);
        if ((absorbs.get(of)!.size > 1 && !rowIntoProse) || dropped.has(i) || dropped.has(of))
          continue;
        if (isTableRow(text, kept[of]!.start) && !isTableRow(text, kept[i]!.start)) continue;
        dropped.add(i);
        keptAs.set(i, of);
        coverage.get(kept[i]!.section.id)!.repeats++;
      }
      // Where each repeat's content now lives: its final keeper, through a
      // chain of drops (A repeats B, B repeats C: A's content is in C), each
      // other section once.
      for (const i of dropped) {
        let at = keptAs.get(i)!;
        while (dropped.has(at)) at = keptAs.get(at)!;
        const cov = coverage.get(kept[i]!.section.id)!;
        const into = kept[at]!.section.id;
        if (into !== cov.sectionId && !cov.mergedInto?.includes(into))
          cov.mergedInto = [...(cov.mergedInto ?? []), into];
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
      // A reference to a dropped repeat points at the statement it repeats.
      refersTo: [
        ...new Set(
          [...(refs.get(i) ?? [])].flatMap((to) => {
            let at = to;
            while (dropped.has(at)) at = keptAs.get(at)!;
            const target = finalId.get(at);
            return target && at !== i ? [target] : [];
          }),
        ),
      ],
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

/** #2374 review — words that carry no content, for {@link isHeldBy}. */
const FUNCTION_WORDS = new Set(
  (
    "a an the and or but nor of to in on at by for from with within into onto after before " +
    "per as than then if when is are was were be been being it its this that these those " +
    "shall must should will can may not no any each all"
  ).split(" "),
);

/** The content words of `text`, lower-cased, a plural `s` dropped (`days` = `day`). */
function contentWordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => !FUNCTION_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Share of a row's content words its prose keeper must say for the row to be held by it. */
const ROW_HELD_SHARE = 0.75;

/**
 * #2374 review — whether the table row `row` says nothing the prose `prose`
 * does not: at least {@link ROW_HELD_SHARE} of the row's content words are in
 * the prose. 02's "| Documents reminder | 21 days after the request |" is held
 * by the sentence of 6.1 that sets both out; "| Booking moved | Email |
 * Immediately |" is not held by an overview that names only the booking.
 */
export function isHeldBy(row: string, prose: string): boolean {
  const words = contentWordsOf(row);
  if (words.length === 0) return false;
  const said = new Set(contentWordsOf(prose));
  return words.filter((w) => said.has(w)).length >= ROW_HELD_SHARE * words.length;
}

/** #2361 review — whether the line holding `at` is a table row (`| a | b |`). */
export function isTableRow(text: string, at: number): boolean {
  return text
    .slice(text.lastIndexOf("\n", at - 1) + 1, at + 1)
    .trimStart()
    .startsWith("|");
}

/**
 * #2361 — the sentence around `[start, end)`: from just after the previous
 * sentence's end (`.`, `!` or `?` before whitespace) or line break, to the
 * next one. A line is never more than one sentence, so a table row or a list
 * item is its own. An abbreviation (`e.g.`) ends a sentence early, which only
 * ever leaves two statements unfolded.
 */
export function sentenceSpan(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const endsSentence = (i: number): boolean =>
    /[.!?]/.test(text[i] ?? "") && (i + 1 >= text.length || /\s/.test(text[i + 1]!));
  let from = start;
  while (from > 0 && text[from - 1] !== "\n" && !endsSentence(from - 1)) from--;
  let to = end;
  // `to > start`: an empty span (`end === start`, as `foldSentences` asks and a
  // direct caller may) right after a full stop is not a finished sentence, so
  // it widens forward to the sentence it starts instead of stopping at once.
  if (!(to > start && endsSentence(to - 1))) {
    while (to < text.length && text[to] !== "\n" && !endsSentence(to)) to++;
    if (to < text.length && text[to] !== "\n") to++;
  }
  return { start: from, end: to };
}

/**
 * #2361 — statements whose quotes lie in one and the same sentence, folded
 * into one: the quote spans them all, the statements are joined, and the kind
 * is the first requirement kind among them (else the first's). One sentence is
 * one statement, as #2229's whole-document read wrote it; `onFolded` is told
 * of every statement folded into another. `kept` is in document order.
 *
 * Only the same single sentence folds: a statement is compared with its own
 * sentence's span, never with a group widened by another, so folding cannot
 * cascade along a paragraph. A quote that runs over several sentences or over
 * a line break (two table rows, a heading) never folds, with anything: the
 * statements beside it may be separate requirements, and a fold must not span
 * lines or sections. Members of a fold share a section, too. The one
 * exception is an exact twin: the same multi-sentence quote with the same
 * statement, written twice, is kept once.
 */
function foldSentences(text: string, kept: Kept[], onFolded: (k: Kept) => void): Kept[] {
  const groups = new Map<string, Kept[]>();
  for (const k of kept) {
    const sentence = sentenceSpan(text, k.start, k.end);
    // In one sentence on one line: the quote ends where its first sentence does.
    const single = sentence.end === sentenceSpan(text, k.start, k.start).end;
    // The section prefix is defensive: one line never crosses a heading, so the
    // sentence alone already fixes the section. A longer quote folds only with
    // an exact twin (the same span, the same statement), as main's key did.
    const said = k.statement.replace(/\s+/g, " ").trim().toLowerCase();
    const key = single
      ? `${k.section.id}:${sentence.start}:${sentence.end}`
      : `twin:${k.start}:${k.end}:${said}`;
    const members = groups.get(key);
    if (members) {
      members.push(k);
      onFolded(k);
    } else {
      groups.set(key, [k]);
    }
  }
  return [...groups.values()].map((members) => {
    const first = members[0]!;
    if (members.length === 1) return first;
    const start = Math.min(...members.map((m) => m.start));
    const end = Math.max(...members.map((m) => m.end));
    const said = new Map<string, string>();
    for (const m of members) {
      const statement = m.statement.trim();
      said.set(statement.replace(/\s+/g, " ").toLowerCase(), statement);
    }
    return {
      kind: (members.find((m) => REQUIREMENT_STATEMENT_KINDS.has(m.kind)) ?? first).kind,
      statement: [...said.values()].map(asSentence).join(" "),
      quote: text.slice(start, end),
      start,
      end,
      section: first.section,
    };
  });
}

/** A statement written to stand as a sentence: capitalised and closed with a full stop. */
function asSentence(statement: string): string {
  const body = statement.replace(/[,;:\s]+$/, "");
  const capital = body.charAt(0).toUpperCase() + body.slice(1);
  return /[.!?]["')\]]*$/.test(capital) ? capital : `${capital}.`;
}

/**
 * #2407 — whether a section has text of its own beyond its heading line. One
 * that does is expected to yield at least one statement (background, if
 * nothing else); a heading with nothing under it before its first subheading
 * is not.
 */
export function hasBody(section: Pick<ReaderSection, "text">): boolean {
  const body = section.text.replace(/^#{1,6}[ \t][^\n]*/, "");
  return /[\p{L}\p{N}]/u.test(body);
}

function startsIn(clause: { clauseStart: number }, span: { start: number; end: number }): boolean {
  return clause.clauseStart >= span.start && clause.clauseStart < span.end;
}
