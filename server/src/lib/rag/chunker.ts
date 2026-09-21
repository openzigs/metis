/**
 * Markdown-aware chunker (Phase 5 / issue #40).
 *
 * Strategy
 * --------
 * 1. Split the document into "sections" along ATX headings (`# … ######`).
 *    Each section carries the heading path so callers can reconstruct the
 *    original document order and surface heading context in retrieval.
 * 2. Within each section, slide a window that RESUMES where the previous chunk
 *    was cut, minus `overlap` characters of carry-over. This keeps related
 *    sentences in the same chunk while avoiding unbounded token blow-ups.
 * 3. Tiling property: consecutive windows within a section abut or overlap, so the
 *    union of the chunks covers the whole section. `server/tests/rag-chunker.test.ts`'s
 *    "chunkMarkdown tiles its input" block asserts this over a fence-heavy,
 *    table-heavy fixture at all four chunk sizes, and `doc-retrieval/corpus.test.ts`
 *    asserts it over the ten real documents of the `docretrieval-01-metis-docs`
 *    corpus.
 *
 * ## The property was false for eight months (#1178)
 *
 * `sliceSection` used to advance `cursor = Math.max(cursor + stride, sliceEnd -
 * overlap)`. Since `sliceEnd <= cursor + chunkSize` always holds, so does
 * `sliceEnd - overlap <= cursor + stride`, so the `Math.max` **always** chose a
 * full stride, and everything in `[sliceEnd, cursor + stride)` was emitted by no
 * chunk. It was a gap, not a shrunken overlap.
 *
 * Measured on the ten real documents of the committed corpus, at the shipped
 * 2048/256: **206 of 4,773 substantive lines were absent from every chunk**, in 30
 * runs of consecutive lines, the longest 22 lines — concentrated in the prose that
 * follows a fenced code block. The union of the chunks covered **94.1%** of the
 * corpus's characters at 2048/256, 85.6% at 1024/128 and 80.4% at 768/96. Because
 * differential content loss mimics a chunk-size effect, that spread is what made
 * #1160's chunk-size sweep uninterpretable. The same line also meant the configured
 * overlap was delivered only when the boundary happened to fall inside the final
 * `overlap` characters — **19.2%** of it at 2048/256.
 *
 * After the fix the union covers 99.8% at every arm (the remainder is inter-chunk
 * whitespace, which `trim()` drops by design) and 98–99% of the configured overlap
 * is delivered.
 *
 * The three rules below are what make the property hold, and each is load-bearing:
 * the window resumes at `sliceEnd - overlap` (never past the cut),
 * {@link MIN_BOUNDARY_FRACTION} keeps a boundary search from proposing a cut so
 * early that the resumed window barely moves, and a line end outranks a mid-line
 * period ({@link SENTENCE_ENDS}) so a chunk does not end in the middle of a table row.
 *
 * ## A fourth rule: `overlap` is capped, not merely bounded (#1185)
 *
 * Tiling is only half of "the window makes progress". The other half is HOW MUCH
 * progress, and that is what {@link maxOverlapFor} exists to guarantee — see
 * {@link guaranteedAdvance} for the arithmetic and the decision it encodes.
 *
 * The chunker is intentionally synchronous, dependency-free, and pure. It
 * takes plain text in and returns plain JS objects out so callers can persist
 * them however they like (Prisma rows, JSON files, fixtures, …).
 */
import crypto from "node:crypto";

export interface Chunk {
  /** 0-based position within the source document. */
  position: number;
  /** Chunk body — already trimmed of leading/trailing whitespace runs. */
  text: string;
  /** Hex md5 of the chunk body — stable identity for dedupe. */
  md5: string;
  /** Heading trail at the time of this chunk (h1 → h6). */
  headings: string[];
  /** Inclusive character offset into the source document where this chunk starts. */
  startOffset: number;
  /** Exclusive character offset where this chunk ends. */
  endOffset: number;
}

export interface ChunkOptions {
  /**
   * Approximate maximum chunk size in characters. Default 2048 (~512 tokens).
   *
   * Raised to {@link MIN_CHUNK_SIZE} if smaller; a non-finite value falls back to
   * the default rather than producing an empty result.
   */
  chunkSize?: number;
  /**
   * Overlap in characters between adjacent chunks. Default 256 (~64 tokens).
   *
   * **CAPPED at {@link maxOverlapFor}(`chunkSize`) — a quarter of the chunk size**
   * (#1185). A larger value is silently reduced to that cap; ask
   * {@link resolveChunkParams} what you will actually get. The cap is what keeps the
   * window advancing by a real fraction of `chunkSize`, so it is a correctness bound
   * rather than a preference — see {@link guaranteedAdvance}.
   */
  overlap?: number;
}

/** What {@link chunkMarkdown} will actually run with, given a caller's options. */
export interface ResolvedChunkParams {
  /** Effective chunk size: integral and at least {@link MIN_CHUNK_SIZE}. */
  chunkSize: number;
  /** Effective overlap: `min(requestedOverlap, maxOverlap)`. */
  overlap: number;
  /** What the caller asked for, after normalisation but BEFORE the cap. */
  requestedOverlap: number;
  /** {@link maxOverlapFor}(`chunkSize`). */
  maxOverlap: number;
}

const DEFAULT_CHUNK_SIZE = 2048;
const DEFAULT_OVERLAP = 256;
const MIN_CHUNK_SIZE = 64;

/**
 * How far into the window a natural boundary must sit to be preferred over a hard
 * cut at the window's end.
 *
 * {@link findBoundary} takes the *last* paragraph break in the window, which is the
 * right instinct — it is the candidate closest to the end — but says nothing about
 * how close that is. A fenced code block or a table longer than one window contains
 * no paragraph break at all, so the last one is the blank line *before* it, perhaps
 * twenty characters in. Honouring that cut and then resuming at
 * `sliceEnd - overlap` would advance the window by almost nothing and emit a long
 * tail of near-duplicate fragments of the same paragraph.
 *
 * Rejecting an early candidate lets the search fall through to the next preference
 * and ultimately to the hard cut, which is the correct behaviour for a run of text
 * with nothing to break on. Because a `lastIndexOf` result below the threshold means
 * there is no occurrence above it either, "reject if too early" and "search only the
 * tail of the window" are the same rule.
 *
 * **This is not a hypothetical.** Removing this floor while keeping the cursor fix —
 * the naive one-line repair — was measured on three inputs (the 200-row table of
 * #1178's own reproduction, a fenced block longer than one window, and a table with
 * no blank line inside). All three produced chunk start offsets of `0, 1, 2, 3, 4,
 * 5, …`: the window advanced **one character per iteration**, saved from spinning
 * forever only by `sliceSection`'s `cursor + 1` clamp, and emitted a run of ~23
 * near-identical 22-character chunks before the early paragraph break finally fell
 * out of the window. `tests/rag-chunker.test.ts` pins that with a minimum-advance
 * assertion on exactly those shapes.
 *
 * It is also what sizes the advance: the window moves
 * `boundaryFloorFor(chunkSize) - overlap` characters at worst, which is why
 * {@link maxOverlapFor} is derived from this fraction rather than picked (#1185).
 */
const MIN_BOUNDARY_FRACTION = 0.5;

/** The first term of {@link findBoundary}'s floor, as a function of the window size. */
function boundaryFloorFor(chunkSize: number): number {
  return Math.ceil(chunkSize * MIN_BOUNDARY_FRACTION);
}

/**
 * Largest `overlap` {@link chunkMarkdown} will honour at a given `chunkSize`:
 * **half of the boundary floor, i.e. a quarter of `chunkSize`** (512 at the shipped
 * 2048).
 *
 * ## What this is protecting (#1185)
 *
 * {@link findBoundary} guarantees `sliceEnd >= cursor + max(boundaryFloorFor(chunkSize),
 * overlap + 1)`, and {@link sliceSection} then resumes at `sliceEnd - overlap`. So the
 * per-iteration advance is `max(boundaryFloorFor(chunkSize), overlap + 1) - overlap`
 * — {@link guaranteedAdvance}. That is 768 at the shipped 2048/256, and it **collapses
 * to 1** the moment `overlap + 1` overtakes the floor, because the two terms then
 * cancel. Before this cap, `overlap` was bounded only by `chunkSize - 1`, and
 * `RAG_CHUNK_OVERLAP` is env-settable, so an operator could reach the collapsed region
 * from configuration alone. Measured on `docs/ARCHITECTURE.md` (503,062 chars) before
 * the cap: **2048/256 → 475 chunks, 1024/512 → 1,162, 2048/2047 → 222,917 chunks and
 * 456 MB of near-duplicate text**, every one of which the ingest path would embed.
 * The loop still terminated — `sliceSection`'s `cursor + 1` clamp saw to that — which
 * is exactly why it was invisible: nothing hung, it just quietly cost ~470× the work.
 *
 * ## Why a quarter and not the obvious half
 *
 * #1185 proposed `Math.min(overlap, Math.floor(chunkSize / 2))`. **That does not fix
 * it.** At `chunkSize = 2048` the cap would be 1024, `overlap + 1 = 1025` still beats
 * the 1024 floor, and the guaranteed advance is `1025 - 1024 = 1` — the collapsed
 * value, reached exactly AT the cap. The same holds for odd sizes
 * (2049 → floor 1025, cap 1024, advance 1), so `chunkSize / 2` is the wrong side of
 * the boundary for both parities and would have shipped the defect under a fix.
 *
 * Halving the floor instead makes the advance monotone and bounded below:
 * `boundaryFloorFor(chunkSize) - overlap >= ceil(boundaryFloorFor(chunkSize) / 2)
 * >= chunkSize / 4`. The bound is also self-describing — **carry-over may never exceed
 * the guaranteed advance** — which caps duplicated output at ~2× the source instead of
 * the ~907× measured above.
 */
export function maxOverlapFor(chunkSize: number): number {
  return Math.floor(boundaryFloorFor(normaliseChunkSize(chunkSize)) / 2);
}

/**
 * Characters the window is guaranteed to advance per iteration at this pair.
 *
 * Stated as a function rather than a comment so it can be **asserted**, both against
 * its own arithmetic and against the offsets a real chunking produces
 * (`tests/rag-chunker.test.ts`, "the window's guaranteed advance"). #1178 shipped for
 * eight months behind a test that asserted four headings and five words; a property
 * that only exists in prose is the same bet.
 *
 * Deliberately accepts RAW values, not a {@link ResolvedChunkParams} — the collapse it
 * describes is a fact about the loop at any pair, and a test has to be able to
 * evaluate it inside the region {@link maxOverlapFor} now keeps callers out of.
 */
export function guaranteedAdvance(chunkSize: number, overlap: number): number {
  const floor = Math.max(boundaryFloorFor(chunkSize), overlap + 1);
  // `sliceSection` clamps to `cursor + 1`, so the advance is never below 1.
  return Math.max(floor - overlap, 1);
}

function normaliseChunkSize(chunkSize: number | undefined): number {
  const raw = chunkSize ?? DEFAULT_CHUNK_SIZE;
  // A non-finite size otherwise propagates NaN through `end`/`sliceEnd` and returns
  // NO chunks at all — silent total loss of the document.
  if (!Number.isFinite(raw)) return DEFAULT_CHUNK_SIZE;
  return Math.max(MIN_CHUNK_SIZE, Math.floor(raw));
}

/**
 * Resolve caller options to the parameters {@link chunkMarkdown} will actually use.
 *
 * ## The decision this encodes: CLAMP, and say so at the configuration boundary
 *
 * An out-of-range `overlap` could be clamped silently, rejected loudly, or warned
 * about and honoured. Honouring it was never on the table — that is the 222,917-chunk
 * behaviour this cap exists to remove, and a warning nobody reads buys nothing.
 *
 * Rejecting is the loud, honest option and it is what {@link chunkMarkdown} already
 * does for a non-string source. It loses on the *blast radius*: `chunkMarkdown` sits on
 * the ingest hot path, `RAG_CHUNK_OVERLAP` is read per-process in
 * `KnowledgeService`'s constructor, and the throw would land per-document inside
 * `ingestDocument`. One mistyped env var would turn a degraded-but-working index into
 * one where no document can be ingested at all. Nothing in the repository asks for an
 * overlap above 12.5% of `chunkSize` (`.env.example` ships 2048/256, every
 * `CHUNK_SIZE_ARMS` arm and `chunk-alignment.test.ts` use 12.5%), so rejection would
 * protect no real caller while adding a new way to take ingest down.
 *
 * Clamping also keeps this option's contract the same SHAPE it has always had: it was
 * already clamped, to `chunkSize - 1`. Tightening the bound is a change of degree; a
 * throw is a change of kind.
 *
 * **So, concretely, for a caller passing `overlap >= chunkSize / 2` today:** the call
 * still succeeds and still returns chunks. What changes is that the overlap is reduced
 * to `chunkSize / 4` — at 2048/1500 the caller used to receive 1500 and now receives
 * 512 — so the chunks are the same size but carry less context forward, and there are
 * *fewer* of them. Nothing throws and no ingest fails.
 *
 * **And clamping is not silent, where silence would cost something.** #1178 survived
 * eight months because nothing announced it, so the two paths are covered separately:
 *
 *   - **Env** (`RAG_CHUNK_OVERLAP`) — an operator cannot read a type. `KnowledgeService`
 *     resolves through this function and logs a warning naming the requested and
 *     effective values. Once per process, at construction: the frequency of the
 *     mistake, not of the documents.
 *   - **Programmatic** (`opts.overlap`) — a caller is code, and the earlier signal is
 *     the better one. The cap is on {@link ChunkOptions.overlap}'s own JSDoc, so it is
 *     in the IDE hover at the call site, and this function returns `requestedOverlap`
 *     and `maxOverlap` alongside the effective value for anyone who wants to check or
 *     reject on their own terms. A per-call `console.warn` from a pure, hot-path
 *     function would be worse on every axis.
 */
export function resolveChunkParams(opts: ChunkOptions = {}): ResolvedChunkParams {
  const chunkSize = normaliseChunkSize(opts.chunkSize);
  const rawOverlap = opts.overlap ?? DEFAULT_OVERLAP;
  const requestedOverlap = Number.isFinite(rawOverlap)
    ? Math.max(0, Math.floor(rawOverlap))
    : DEFAULT_OVERLAP;
  const maxOverlap = maxOverlapFor(chunkSize);
  return {
    chunkSize,
    overlap: Math.min(requestedOverlap, maxOverlap),
    requestedOverlap,
    maxOverlap,
  };
}

/**
 * Bumped whenever a change to this module MOVES CHUNK BOUNDARIES for some input.
 *
 * ## Why a version and not just the parameters (#1182)
 *
 * `KnowledgeChunk.chunkerIdentity` exists so a store holding two chunker
 * generations is visible instead of silent.
 *
 * **It is NOT what makes #1178 detectable** — an earlier draft of this comment
 * claimed that and was wrong, caught by PR #1182's review panel. Because the column
 * is new and deliberately not backfilled, every pre-#1178 row is NULL whatever the
 * tag's shape, so a parameters-only tag would separate the two #1178 generations
 * exactly as well (NULL vs `2048/256`).
 *
 * The version earns its place on the NEXT boundary change, not the last one: once
 * both generations carry a tag, a same-parameter change to this module — which is
 * precisely what #1178 was — produces two identical `2048/256` strings and the drift
 * becomes invisible again. The version is the only field that separates them. That
 * is the same reasoning #792 applied to the *embedding* identity
 * (`model|pooling|dtype`) after a same-model pooling flip changed the vectors.
 *
 * ## What keeps it honest
 *
 * A constant a human must remember to bump is itself fail-open, so it is not left
 * to memory. `tests/rag-chunker-identity.test.ts` guards it two ways, and the split
 * between them matters because the first alone was measurably not enough:
 *
 *  1. **A digest** of the exact boundary signature this version produces over a
 *     fixture reaching every tier of {@link findBoundary}, at all four sweep arms.
 *     Change a boundary rule without bumping and it fails naming this constant; bump
 *     without recording a signature and it fails for the opposite reason.
 *  2. **A per-tier gate** over {@link BOUNDARY_TIERS} — one arm per tier deleted, one
 *     per adjacent pair transposed — each required to move a boundary.
 *
 * (2) exists because a digest over a fixed chunker pins each tier's *arithmetic* and
 * is blind to its *existence and precedence*: PR #1194's review measured that
 * deleting the paragraph tier, and separately demoting it below the line tier, both
 * left the digest byte-identical, because the fixture's paragraphs were single lines
 * and the two tiers therefore agreed on every window. Both mutations fail now, and
 * so does every other tier's.
 *
 * The scope of the guarantee, stated exactly: **any change that moves a boundary for
 * the fixture at any of the four arms fails the digest, and any deletion or adjacent
 * reordering of a tier fails the gate.** A boundary change that no fixture shape
 * exercises is still invisible — which is why (2) mutates the code rather than
 * trusting the corpus, and why a new tier must arrive with a fixture shape only it
 * can cut.
 *
 * History:
 *   v1 — the original chunker. Did not tile its input: `sliceSection` advanced a
 *        full stride past the cut, so `[sliceEnd, cursor + stride)` was emitted by
 *        no chunk (#1178). Never written to the database — every row predating
 *        #1182 carries a NULL `chunkerIdentity` and is v1 by definition.
 *   v2 — #1178 (resume at the cut) + #1178's line-end boundary tier +
 *        #1185's `maxOverlapFor` cap. The first generation that tiles.
 */
export const CHUNKER_ALGORITHM_VERSION = 2;

/**
 * Producer segment of {@link chunkerIdentity} — the chunker that cut the row.
 *
 * `KnowledgeChunk` has **more than one writer**, which PR #1182's review panel caught
 * after the first draft asserted it had one. `docs-gen/rag-ingest.ts` ingests generated
 * documents through its own private 1,500-character chunker and writes
 * `knowledge_chunks` rows directly (`DOCSGEN_CHUNKER_IDENTITY`). Those rows are not a
 * stale generation of *this* chunker; they are a different corpus cut by a different
 * algorithm, and #1178 never touched them.
 *
 * Without a producer segment the drift check compares them against this chunker's
 * identity, finds a mismatch that can never be reconciled — re-running generation
 * re-runs the same foreign chunker — and pins `embeddings:migrate status` at exit 3
 * forever, prescribing a remedy that cannot clear it. Measured on the live dev
 * database during review: 103 of 1,415 chunk rows, in 2 of 3 projects.
 */
export const DOCUMENT_CHUNKER_PRODUCER = "doc";

/**
 * The identity of the chunking a call with these options would produce:
 * producer, algorithm version and EFFECTIVE parameters — e.g. `doc:v2:2048/256`.
 *
 * Effective, not requested, on purpose. `overlap` is capped at
 * {@link maxOverlapFor} (#1185), so `2048/1500` and `2048/512` produce
 * byte-identical chunks; tagging them differently would report a drift that does
 * not exist and send an operator into a re-ingest that changes nothing.
 */
export function chunkerIdentity(opts: ChunkOptions = {}): string {
  const { chunkSize, overlap } = resolveChunkParams(opts);
  return `${DOCUMENT_CHUNKER_PRODUCER}:v${CHUNKER_ALGORITHM_VERSION}:${chunkSize}/${overlap}`;
}

/**
 * The producer segment of a persisted identity, or `""` when there is none.
 *
 * Split on the FIRST separator — never `startsWith`. A prefix test would make
 * `doc` match the `docsgen` producer, which is the substring-vs-segment confusion
 * that de-gated a path check in #1172.
 */
export function chunkerProducerOf(identity: string): string {
  const i = identity.indexOf(":");
  return i === -1 ? "" : identity.slice(0, i);
}

/**
 * How a persisted `chunkerIdentity` stands against the active one.
 *
 * - `current` — cut by the chunker and parameters in force now.
 * - `drifted` — cut by a superseded generation of the SAME producer. Re-ingest.
 * - `untagged` — provenance unrecorded: NULL, empty, or a value carrying no producer
 *   segment at all. Treated as drift, because the pre-#1178 rows this issue exists
 *   for are all in here and defaulting the unknown case to "fine" is how a gate ships
 *   already open.
 * - `foreign` — cut by a DIFFERENT, NAMED producer. Not comparable, not drift, and
 *   excluded from the verdict: the row is correct output of another chunker.
 *
 * **The two unknown cases fail in opposite directions, deliberately.** An unrecorded
 * provenance fails CLOSED (counted as outstanding); a named foreign producer fails
 * OPEN (excluded). The distinction is whether anything is actually claimed: `docsgen`
 * is a producer we know about and have decided not to track (see
 * `DOCSGEN_CHUNKER_IDENTITY` and ADR 0006), whereas a malformed or separator-less
 * value tells us nothing and must not buy silence. A value like `"noseparator"` used
 * to land in `foreign` and so be silently dropped from the verdict — unreachable
 * today, since both writers use constants, but the wrong polarity for the one case
 * that can only arise from corruption or a bug.
 */
export type ChunkerDriftClass = "current" | "drifted" | "untagged" | "foreign";

export function classifyChunkerIdentity(
  stored: string | null | undefined,
  active: string,
): ChunkerDriftClass {
  if (stored === null || stored === undefined || stored === "") return "untagged";
  if (stored === active) return "current";
  // No producer segment ⇒ nothing is claimed ⇒ fail closed, like NULL. Checked before
  // the producer comparison, which would otherwise route "" into `foreign`.
  if (chunkerProducerOf(stored) === "") return "untagged";
  if (chunkerProducerOf(stored) !== chunkerProducerOf(active)) return "foreign";
  return "drifted";
}

interface Section {
  headings: string[];
  body: string;
  startOffset: number;
}

/**
 * Split a markdown document into ordered chunks suitable for embedding.
 *
 * Empty / whitespace-only documents return `[]`. Documents with no headings
 * are treated as a single "untitled" section.
 */
export function chunkMarkdown(source: string, opts: ChunkOptions = {}): Chunk[] {
  if (typeof source !== "string") {
    throw new TypeError("source must be a string");
  }
  const { chunkSize, overlap } = resolveChunkParams(opts);
  if (source.trim().length === 0) return [];

  const sections = splitSections(source);
  const chunks: Chunk[] = [];
  let position = 0;
  for (const section of sections) {
    const sectionChunks = sliceSection(section, chunkSize, overlap, position);
    chunks.push(...sectionChunks);
    position += sectionChunks.length;
  }
  return chunks;
}

/** Re-export under the AC-named alias used by the knowledge service. */
export const chunkDocument = chunkMarkdown;

function splitSections(source: string): Section[] {
  const lines = source.split(/\r?\n/);
  const headingStack: { level: number; text: string }[] = [];
  let currentHeadings: string[] = [];
  let currentBody: string[] = [];
  let currentStart = 0;
  let runningOffset = 0;
  const sections: Section[] = [];

  const flush = (): void => {
    const body = currentBody.join("\n");
    if (body.trim().length > 0 || currentHeadings.length > 0) {
      const headerText = currentHeadings.length > 0 ? `${headerLine(currentHeadings)}\n` : "";
      sections.push({
        headings: [...currentHeadings],
        body: `${headerText}${body}`.trim(),
        startOffset: currentStart,
      });
    }
    currentBody = [];
    currentStart = runningOffset;
  };

  for (const rawLine of lines) {
    const lineLength = rawLine.length + 1; // include newline
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(rawLine);
    if (headingMatch) {
      flush();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text });
      currentHeadings = headingStack.map((h) => h.text);
      currentStart = runningOffset;
    } else {
      currentBody.push(rawLine);
    }
    runningOffset += lineLength;
  }
  flush();
  return sections;
}

function headerLine(headings: string[]): string {
  // Reproduce the deepest heading verbatim so round-trip tests can locate it.
  const last = headings[headings.length - 1];
  return `${"#".repeat(headings.length)} ${last}`;
}

function sliceSection(
  section: Section,
  chunkSize: number,
  overlap: number,
  startPosition: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  const body = section.body;
  if (body.length === 0) return chunks;
  if (body.length <= chunkSize) {
    chunks.push(makeChunk(body, startPosition, section, section.startOffset));
    return chunks;
  }
  let cursor = 0;
  let local = 0;
  while (cursor < body.length) {
    const end = Math.min(body.length, cursor + chunkSize);
    let sliceEnd = end;
    if (end < body.length) {
      sliceEnd = findBoundary(body, cursor, end, overlap);
    }
    const slice = body.slice(cursor, sliceEnd).trim();
    if (slice.length > 0) {
      chunks.push(makeChunk(slice, startPosition + local, section, section.startOffset + cursor));
      local += 1;
    }
    if (sliceEnd >= body.length) break;
    // RESUME at the cut, minus the carry-over. Advancing by a fixed stride instead is
    // what dropped `[sliceEnd, cursor + stride)` out of the index entirely (#1178);
    // `sliceEnd` is where this chunk actually ended, so starting the next window at or
    // before it is the whole tiling guarantee. `findBoundary`'s floor already keeps
    // `sliceEnd - overlap` above `cursor`; the clamp holds the loop's termination as a
    // property of THIS function rather than of a constant in another one.
    cursor = Math.max(sliceEnd - overlap, cursor + 1);
  }
  return chunks;
}

/**
 * Mid-line sentence terminators — the tier BELOW a line end.
 *
 * A line end used to be reachable only as `".\n"` / `"!\n"` / `"?\n"`, peers of the
 * mid-line `". "`, and `findBoundary` takes whichever candidate sits latest in the
 * window. So a period that ends no sentence at all — `"(e.g. "`, `"(#849). "` — would
 * out-rank the last newline whenever it happened to fall later, and the chunk ended in
 * the middle of a table row.
 *
 * That does not break tiling (the next window still resumes at `sliceEnd - overlap`),
 * but a row longer than `overlap` then appears **whole** in no chunk: its head is at
 * the end of one and its tail at the start of the next, and a substring search for the
 * row finds neither. Measured on the committed corpus, that was the entire residue
 * after the cursor fix — 57 lines at 768/96, 31 at 1024/128, 2 at 2048/256 — and every
 * one of them was longer than its arm's overlap.
 *
 * Promoting `"\n"` to its own tier above these fixes it, and is the right precedence
 * on the merits: in markdown a line end is a stronger structural boundary than a
 * period, which may be an abbreviation, a version number or a file extension. The
 * `".\n"` forms are gone because a bare `"\n"` matches them at the same offset.
 */
const SENTENCE_ENDS = [". ", "! ", "? "];

/** One rule in {@link BOUNDARY_TIERS}. */
export interface BoundaryTier {
  /** Stable name, used by the per-tier gate's failure messages. */
  readonly name: string;
  /**
   * Offset just PAST this tier's best boundary in `window`, or -1 when the tier has
   * no candidate. Returning the offset already advanced past the separator is what
   * lets every tier be compared against the floor by the same expression, whatever
   * separator lengths it holds.
   */
  readonly end: (window: string) => number;
}

/**
 * The ordered boundary rules, **as data rather than as a chain of `if`s**.
 *
 * Paragraph break → line end → mid-line sentence terminator → any space; a window
 * with no accepted candidate falls through to the hard cut in {@link findBoundary}.
 *
 * The table exists so the pin can mutate it. A digest recorded over a fixed chunker
 * pins each tier's *arithmetic* — change `+2` to `+1` and the digest moves — but it
 * cannot see a tier's **existence or precedence**, and PR #1182's review panel
 * measured exactly that hole: with single-line paragraphs, deleting the paragraph
 * tier or demoting it below the line tier both left the digest byte-identical.
 * `tests/rag-chunker-identity.test.ts` now builds variant tier lists from this array
 * — one with each tier deleted, one for each adjacent transposition — and requires
 * every one of them to move a boundary. That makes "all five tiers are pinned" a
 * measured property of the code instead of a claim in a comment.
 */
export const BOUNDARY_TIERS: readonly BoundaryTier[] = [
  { name: "paragraph", end: (w) => lastEndOfAny(w, ["\n\n"]) },
  { name: "line", end: (w) => lastEndOfAny(w, ["\n"]) },
  { name: "sentence", end: (w) => lastEndOfAny(w, SENTENCE_ENDS) },
  { name: "space", end: (w) => lastEndOfAny(w, [" "]) },
];

/**
 * Where to cut the window `[from, to)`, taking the first tier with a candidate at or
 * after the floor and hard-cutting at `to` when none has one.
 *
 * `tiers` is injectable for the per-tier gate only — production always takes the
 * default. Exported for the same reason.
 */
export function findBoundary(
  body: string,
  from: number,
  to: number,
  overlap: number,
  tiers: readonly BoundaryTier[] = BOUNDARY_TIERS,
): number {
  const window = body.slice(from, to);
  // `to - from` is always `chunkSize` here — the caller only searches when a full
  // window remains — so the floor never exceeds the window and a hard cut at `to`
  // always satisfies it.
  //
  // The `overlap + 1` term is the LOCAL termination proof: whatever `overlap` is, the
  // cut lands past `from + overlap`, so `sliceEnd - overlap > from`. Since #1185 capped
  // `overlap` at half the boundary floor it can no longer win the `max`, and keeping it
  // is what stops termination becoming a property of a constant in another function.
  //
  // `floor >= 1` always (`overlap >= 0`), which is what lets a tier's "no candidate"
  // sentinel of -1 be rejected by the same comparison that rejects a too-early one.
  const floor = Math.max(boundaryFloorFor(to - from), overlap + 1);
  for (const tier of tiers) {
    const end = tier.end(window);
    if (end >= floor) return from + end;
  }
  return to;
}

/**
 * Offset just PAST the last occurrence of any needle, or -1 when none occurs.
 *
 * Returning the end rather than the start keeps the caller from having to add a
 * needle length it cannot know once a tier holds needles of differing lengths.
 */
function lastEndOfAny(haystack: string, needles: string[]): number {
  let best = -1;
  for (const n of needles) {
    const idx = haystack.lastIndexOf(n);
    if (idx >= 0 && idx + n.length > best) best = idx + n.length;
  }
  return best;
}

function makeChunk(text: string, position: number, section: Section, offset: number): Chunk {
  return {
    position,
    text,
    md5: crypto.createHash("md5").update(text).digest("hex"),
    headings: [...section.headings],
    startOffset: offset,
    endOffset: offset + text.length,
  };
}
