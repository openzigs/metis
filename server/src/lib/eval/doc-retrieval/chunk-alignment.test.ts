import { describe, expect, it } from "vitest";
import { chunkMarkdown, type Chunk } from "../../rag/chunker.js";
import {
  alignChunksToSource,
  bestCoveringChunk,
  coverageFraction,
  overlapChars,
  type AlignedChunk,
} from "./chunk-alignment.js";

const chunk = (text: string, position = 0): Chunk => ({
  position,
  text,
  md5: "",
  headings: [],
  startOffset: 0,
  endOffset: 0,
});

const aligned = (ranges: Array<[number, number]>): AlignedChunk[] =>
  ranges.map(([start, end], i) => ({ position: i, text: `c${i}`, start, end }));

describe("overlapChars", () => {
  it("measures the intersection of two ranges", () => {
    expect(overlapChars(0, 10, 5, 20)).toBe(5);
  });

  it("is zero for disjoint ranges", () => {
    expect(overlapChars(0, 10, 10, 20)).toBe(0);
    expect(overlapChars(30, 40, 0, 10)).toBe(0);
  });

  it("is the contained range's length when one contains the other", () => {
    expect(overlapChars(0, 100, 20, 30)).toBe(10);
  });
});

describe("alignChunksToSource", () => {
  it("locates a plain chunk at its true source offset", () => {
    const source = "aaaa BBBB cccc";
    expect(alignChunksToSource(source, [chunk("BBBB")])).toEqual([
      { position: 0, text: "BBBB", start: 5, end: 9 },
    ]);
  });

  /**
   * The chunker re-emits a section's heading with a `#` count equal to heading
   * DEPTH, which need not match the level written in the source. That synthesised
   * line is why the chunker's own `startOffset` cannot be trusted here.
   */
  it("locates a chunk whose synthesised heading does not match the source's level", () => {
    const source = "# Top\n\n### Nested\n\nbody text here\n";
    const [a] = alignChunksToSource(source, [chunk("## Nested\nbody text here")]);
    expect(source.slice(a.start, a.end)).toBe("body text here");
  });

  /**
   * A heading-only chunk (a section with an empty body) still gets a real position.
   * The assertion is that it lands ON its heading line — not on a precise offset,
   * because `### Empty` literally contains the synthesised `## Empty` as a
   * substring, so the direct match can legitimately start one character in.
   */
  it("anchors a heading-only chunk on its own heading line", () => {
    const source = "# Top\n\n### Empty\n\n### Other\n";
    const [a] = alignChunksToSource(source, [chunk("## Empty")]);
    const headingStart = source.indexOf("### Empty");
    expect(a.start).toBeGreaterThanOrEqual(headingStart);
    expect(a.end).toBeLessThanOrEqual(headingStart + "### Empty".length);
    expect(source.slice(a.start, a.end)).toContain("Empty");
  });

  it("anchors a heading-only chunk when the heading text is the only findable anchor", () => {
    const source = "# Top\n\nintro\n\n@@Empty@@\n";
    const [a] = alignChunksToSource(source, [chunk("## Empty")]);
    expect(source.slice(a.start, a.end)).toBe("Empty");
  });

  /**
   * The contract the cursor buys, stated exactly: a chunk is never located BEFORE
   * the previous chunk's start. Here `dup` occurs at offset 0 — earlier than the
   * preceding chunk — so a plain `indexOf` from zero would place chunk 1 in front
   * of chunk 0. Remove `cursor = located.start` from `alignChunksToSource` and this
   * test fails, which is what makes it worth having.
   *
   * The cursor advances to the previous chunk's START, not its end, because overlap
   * means chunk i+1 legitimately begins before chunk i finishes. Two BYTE-IDENTICAL
   * adjacent chunks therefore both resolve to the earlier offset — the documented
   * repetitive-input limit, not something this test should pretend otherwise about.
   */
  it("never locates a chunk before the previous chunk's start", () => {
    const source = "dup\nsomething\nmiddle\ndup\n";
    const out = alignChunksToSource(source, [chunk("middle", 0), chunk("dup", 1)]);
    expect(out[0].start).toBe(source.indexOf("middle"));
    // The LATER `dup`, not the one at offset 0.
    expect(out[1].start).toBe(source.lastIndexOf("dup"));
    expect(out[1].start).toBeGreaterThan(out[0].start);
  });

  it("throws rather than guessing when a chunk cannot be located", () => {
    expect(() => alignChunksToSource("real source", [chunk("not present at all")])).toThrow(
      /could not be located in its source document/,
    );
  });

  /**
   * The property the whole harness rests on: every chunk the production chunker
   * produces maps back onto the exact bytes of the source it came from.
   */
  it("round-trips every chunk of a realistic document at every arm", () => {
    const source = [
      "# Title",
      "",
      "Intro paragraph that is reasonably long so it survives slicing. ".repeat(20),
      "",
      "## Section A",
      "",
      "Alpha content. ".repeat(120),
      "",
      "### Deeply nested",
      "",
      "Beta content with `code` and | tables |. ".repeat(90),
      "",
      "## Section B",
      "",
      "short",
    ].join("\n");
    for (const size of [768, 1024, 2048, 3072]) {
      const chunks = chunkMarkdown(source, { chunkSize: size, overlap: Math.round(size * 0.125) });
      const out = alignChunksToSource(source, chunks);
      expect(out.length).toBe(chunks.length);
      for (const a of out) {
        expect(a.end).toBeGreaterThan(a.start);
        expect(a.end).toBeLessThanOrEqual(source.length);
      }
    }
  });
});

describe("bestCoveringChunk", () => {
  it("picks the chunk holding the most of the span", () => {
    const chunks = aligned([
      [0, 100],
      [90, 200],
      [190, 300],
    ]);
    expect(bestCoveringChunk(chunks, 95, 150)).toMatchObject({ index: 1, overlap: 55 });
  });

  it("returns exactly one relevant chunk even when the span straddles a boundary", () => {
    const chunks = aligned([
      [0, 100],
      [100, 200],
    ]);
    // 20 characters fall in chunk 0 and 30 in chunk 1, so chunk 1 wins outright —
    // and exactly ONE chunk is relevant, which is what keeps arms comparable.
    const best = bestCoveringChunk(chunks, 80, 130);
    expect(best?.index).toBe(1);
    expect(best?.overlap).toBe(30);
  });

  it("breaks ties toward the earlier chunk so the choice is deterministic", () => {
    const chunks = aligned([
      [0, 100],
      [100, 200],
    ]);
    expect(bestCoveringChunk(chunks, 90, 110)?.index).toBe(0);
  });

  it("reports the fraction of the span the winner actually holds", () => {
    const chunks = aligned([[0, 100]]);
    expect(bestCoveringChunk(chunks, 80, 120)?.fraction).toBeCloseTo(0.5, 6);
  });

  it("is null when no chunk touches the span", () => {
    expect(bestCoveringChunk(aligned([[0, 10]]), 500, 600)).toBeNull();
  });

  it("is null for a degenerate empty span", () => {
    expect(bestCoveringChunk(aligned([[0, 10]]), 5, 5)).toBeNull();
  });
});

describe("coverageFraction", () => {
  it("is 1 when a single chunk contains the whole span", () => {
    expect(coverageFraction(aligned([[0, 1000]]), 100, 200)).toBe(1);
  });

  it("is 0 when the span is uncovered", () => {
    expect(coverageFraction(aligned([[0, 10]]), 900, 950)).toBe(0);
  });
});
