/**
 * Epic #1156 / Issue #1160 — mapping produced chunks back onto SOURCE character
 * offsets, so span-anchored ground truth can be evaluated at any chunk size.
 *
 * ## Why the chunker's own offsets are not used
 *
 * {@link import("../../rag/chunker.js").Chunk} carries `startOffset` / `endOffset`,
 * but they are approximate by construction and cannot be trusted as an evaluation
 * anchor. `chunkMarkdown` builds each section's body as
 * `"#".repeat(headings.length) + " " + lastHeading + "\n" + originalLines`
 * (`chunker.ts:94,127-131`) — a **synthesised** heading line whose `#` count is the
 * heading DEPTH, not the level written in the source. So a `### Foo` nested under
 * one `# H1` is re-emitted as `## Foo`, the section body is a different length
 * from the source region it came from, and `section.startOffset + cursor` drifts
 * by the difference. `endOffset` compounds it: it is `offset + text.length` *after*
 * a `trim()` that removed characters from the front.
 *
 * Off-by-a-few offsets would be invisible in normal use and fatal here, because
 * "does this chunk overlap the answer span?" is decided on exactly those numbers.
 * So this module RE-DERIVES the offsets by locating each chunk's text in the
 * source, and fails loudly when it cannot.
 *
 * ## Why relevance is "the single best-covering chunk"
 *
 * The tempting rule — *any* chunk overlapping the span is relevant — is biased
 * toward small chunks. A 150-character span straddles a boundary with probability
 * roughly `span / stride`, so at 768/96 (stride 672) it yields two relevant chunks
 * about 22% of the time versus about 8% at 2048/256 (stride 1792). More relevant
 * chunks means more ways to score a hit in the top ten, and the small arms would
 * win on an artefact of the grading rule rather than on retrieval quality.
 *
 * Taking the **maximum-overlap chunk** yields exactly one relevant chunk per query
 * at every arm, so nDCG@10 and recall@k are computed against an identically-sized
 * relevant set no matter what the chunk size is. The cost of that choice — that a
 * straddled span leaves its best chunk holding only part of the answer — is not
 * discarded: {@link coverageFraction} reports it, and the sweep aggregates it as
 * `meanSpanCoverage` so the straddle penalty of small chunks stays visible instead
 * of being defined away.
 *
 * The residual bias of max-overlap runs AGAINST the small arms, not for them: a
 * straddled span's answer lives in two chunks and only one of them is graded
 * relevant, so returning the sibling scores 0. That is the safe direction for a null
 * result — it can only make "smaller helps" harder to demonstrate, never easier —
 * but it is a real penalty, which is why `chunk-sweep.ts` reports a **coverage-clean**
 * subset (spans fully covered at BOTH arms) alongside `ranking only`, which excludes
 * dropped spans but keeps straddled ones.
 *
 * ## Fixed-k is deliberate, and it is not what produces the result
 *
 * Every arm is scored at a fixed {@link import("./chunk-sweep.js").DOC_EVAL_K} = 10,
 * so the 2048 control gets ≈20.5k characters in the graded window while 768 gets
 * ≈7.7k — a 2.7× context advantage pointing the same way as the measured result.
 * This is the first objection a reader raises, so it was tested rather than argued.
 *
 * Measured on this corpus (PR #1179 review, one retrieval per arm at k=40 scored at
 * matched ~20.5k-character budgets):
 *
 * | arm | k at ~20.5k chars | nDCG@k | recall@k |
 * |---|---:|---:|---:|
 * | `size-2048` | 10 | 0.756 | 0.917 |
 * | `size-1024` | 20 | 0.663 | 0.813 |
 * | `size-768`  | 27 | 0.641 | 0.833 |
 * | `size-3072` | 5 (15.4k) | 0.775 | 0.854 |
 *
 * **The ordering is unchanged.** Handing the small arms 2–2.7× the slots does not
 * recover them, so fixed-k is not manufacturing the finding. One footnote for anyone
 * re-running it: nDCG@10 is not invariant to the *requested* k, because
 * `fusionPoolSize = max(k*4, 20)` (`knowledge-service.ts:525`) — retrieving at k=40
 * and scoring @10 gives 0.631 at 768 against 0.618 at k=10. Same conclusion, slightly
 * different numbers.
 */
import type { Chunk } from "../../rag/chunker.js";

/** A produced chunk with its re-derived character range in the source document. */
export interface AlignedChunk {
  /** Position within the document, as `chunkMarkdown` numbered it. */
  position: number;
  text: string;
  /** Inclusive character offset in the source document. */
  start: number;
  /** Exclusive character offset in the source document. */
  end: number;
}

/** Leading synthesised heading line that `chunkMarkdown` prepends to a section. */
const SYNTHETIC_HEADING = /^#{1,6} [^\n]*\n?/;

/**
 * Re-derive each chunk's character range in `source`.
 *
 * Chunks are emitted in document order, and overlap means chunk *i+1* starts at or
 * after chunk *i*'s start (never before) — but it may well start before chunk *i*
 * ENDS. So the cursor advances to each match's START, not its end.
 *
 * What that buys, stated exactly: a chunk is never located BEFORE the previous
 * chunk's start, so a line of boilerplate ("| --- | --- |") recurring earlier in the
 * document cannot capture a later chunk. What it does NOT buy: two byte-identical
 * ADJACENT chunks both resolve to the earlier offset, because the cursor cannot
 * advance past the previous chunk's start without risking a legitimate overlap. See
 * the repetitive-input limit below.
 *
 * Throws when a chunk cannot be located. That is the correct response: a silent
 * fallback would place the chunk at an arbitrary offset and quietly corrupt every
 * relevance judgement that depends on it.
 *
 * **Known limit — pathologically repetitive input.** A document built from many
 * byte-identical lines (200 copies of `| a | b | c |`) makes every chunk match at
 * the earliest identical occurrence, so the derived ranges bunch toward the front
 * and real coverage gaps get filled in spuriously. Real prose documentation does
 * not do this — the committed corpus's gaps reproduce correctly — but a synthetic
 * fixture easily can, so do not build one to test coverage behaviour.
 */
export function alignChunksToSource(source: string, chunks: readonly Chunk[]): AlignedChunk[] {
  const out: AlignedChunk[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    const located = locateChunk(source, chunk.text, cursor);
    if (located === null) {
      throw new Error(
        `Chunk at position ${chunk.position} could not be located in its source document. ` +
          `The chunker's output is expected to be a contiguous span of the source once its ` +
          `synthesised heading line is removed; this one was not. Chunk began: ` +
          JSON.stringify(chunk.text.slice(0, 80)),
      );
    }
    out.push({
      position: chunk.position,
      text: chunk.text,
      start: located.start,
      end: located.start + located.length,
    });
    cursor = located.start;
  }
  return out;
}

/**
 * Locate one chunk's body in the source.
 *
 * Tries the chunk verbatim first (true for every chunk after a section's first),
 * then with the synthesised heading line stripped (the section's first chunk,
 * whose `#` prefix may not match the source's). A heading-only chunk — a section
 * with an empty body — has no body to locate, so its heading TEXT is used, which
 * gives it a real position without pretending it has content.
 */
function locateChunk(
  source: string,
  text: string,
  from: number,
): { start: number; length: number } | null {
  const direct = source.indexOf(text, from);
  if (direct !== -1) return { start: direct, length: text.length };

  const withoutHeading = text.replace(SYNTHETIC_HEADING, "");
  if (withoutHeading.length > 0 && withoutHeading !== text) {
    const idx = source.indexOf(withoutHeading, from);
    if (idx !== -1) return { start: idx, length: withoutHeading.length };
  }

  // Heading-only chunk: anchor on the heading text itself.
  const headingText = /^#{1,6} ([^\n]*)/.exec(text)?.[1]?.trim();
  if (headingText) {
    const idx = source.indexOf(headingText, from);
    if (idx !== -1) return { start: idx, length: headingText.length };
  }
  return null;
}

/** Overlap in characters between two half-open ranges. */
export function overlapChars(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** The best-covering chunk for a span, and how much of the span it holds. */
export interface SpanCoverage {
  /** Index into the aligned-chunk array. */
  index: number;
  /** Characters of the span this chunk contains. */
  overlap: number;
  /** `overlap / spanLength`, in [0, 1]. */
  fraction: number;
}

/**
 * The chunk that best covers `[spanStart, spanEnd)` — the query's single relevant
 * chunk at this arm.
 *
 * Ties break toward the EARLIER chunk so the choice is deterministic; a tie means
 * the span is split exactly evenly and either half is equally defensible.
 *
 * Returns `null` only when no chunk overlaps the span at all. Before #1178 that
 * happened whenever `chunkMarkdown` failed to tile its input (see `wired-harness.ts`'s
 * `relevantChunksForArm`); it no longer occurs on the committed corpus at any arm. The
 * sweep scores such a query **0**, substituting an unretrievable sentinel so the
 * relevant-set size stays 1 and the arm's macro-average stays comparable. That is
 * deliberate: retrieval genuinely cannot return content the index does not hold. The
 * `ranking only` subset, which excludes every query affected at either arm, is retained
 * for the same reason — it is what makes a future regression legible rather than
 * silently absorbed into a delta.
 */
export function bestCoveringChunk(
  chunks: readonly AlignedChunk[],
  spanStart: number,
  spanEnd: number,
): SpanCoverage | null {
  const spanLength = spanEnd - spanStart;
  if (spanLength <= 0) return null;
  let best: SpanCoverage | null = null;
  for (let i = 0; i < chunks.length; i += 1) {
    const overlap = overlapChars(chunks[i].start, chunks[i].end, spanStart, spanEnd);
    if (overlap <= 0) continue;
    if (best === null || overlap > best.overlap) {
      best = { index: i, overlap, fraction: overlap / spanLength };
    }
  }
  return best;
}

/**
 * Characters that adjacent chunks actually SHARE, summed over a document.
 *
 * This is realised overlap, not configured overlap, and the two were not the same
 * number before #1178. `sliceSection` cut each chunk at `findBoundary(...)` and then
 * advanced `cursor` by a full stride regardless, so the window only overlapped its
 * predecessor when the boundary happened to land inside the final `overlap`
 * characters — **19.2%** of the configured overlap at the shipped 2048/256, which is
 * what made #1160's overlap arm compare two nearly identical chunkings rather than
 * two overlap settings. Since #1178 the window resumes at the cut and 98–99% is
 * delivered.
 *
 * Beware the denominator: it must count only WITHIN-section chunk boundaries. Counting
 * section transitions as continuations inflates it about ninefold on this corpus and
 * is where #1178's original "~98% undelivered" figure came from — see
 * `wired-harness.ts`'s {@link import("./wired-harness.js").measureOverlapDelivery}.
 *
 * Computed from re-derived source offsets rather than from the chunker's own, for the
 * reason this module exists.
 */
export function realisedOverlapChars(chunks: readonly AlignedChunk[]): number {
  let total = 0;
  for (let i = 1; i < chunks.length; i += 1) {
    total += Math.max(0, chunks[i - 1].end - chunks[i].start);
  }
  return total;
}

/** Fraction of a span held by its best-covering chunk, or 0 when uncovered. */
export function coverageFraction(
  chunks: readonly AlignedChunk[],
  spanStart: number,
  spanEnd: number,
): number {
  return bestCoveringChunk(chunks, spanStart, spanEnd)?.fraction ?? 0;
}
