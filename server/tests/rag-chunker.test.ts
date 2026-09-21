/**
 * Chunker tests (Phase 5 / issue #40; tiling property #1178).
 *
 * Round-trip property: every heading text and every body line from the
 * source markdown survives chunking — no content is silently dropped.
 *
 * ## Why the old round-trip test was worthless, and what replaced it
 *
 * The test that used to sit here was named "round-trips: every heading and word
 * from the source appears in some chunk" and asserted **four named headings and
 * five hand-picked words** against a small, benign `SAMPLE`. It passed for eight
 * months while the shipped configuration was dropping ~6% of the non-whitespace
 * characters of METIS's own documentation on the floor (#1178). The fixture could
 * not reach the failing condition and the assertion could not have seen it if it
 * had — a weak proxy over a benign fixture, the same shape as #1158's reranker,
 * which "scored" every pair 1.0 for as long as anyone had looked.
 *
 * So the replacement asserts the property the module's header actually claims —
 * **every** substantive source line, not a curated five — over {@link OPS_DOCUMENT},
 * a fixture built to look like the documents the defect bit: fenced code blocks with
 * no internal blank line, prose immediately after a fence, and long tables. Every
 * line of it is unique, because the check is a substring test and a repeated line
 * would let a dropped copy hide behind a surviving one.
 */
import { describe, expect, it } from "vitest";
import { armOverlap, CHUNK_SIZE_ARMS } from "../src/lib/eval/doc-retrieval/chunk-sweep.js";
import {
  chunkDocument,
  chunkMarkdown,
  guaranteedAdvance,
  maxOverlapFor,
  resolveChunkParams,
} from "../src/lib/rag/chunker.js";

const SAMPLE = `# Architecture

The METIS server is a TypeScript Express 5 application backed by Prisma. It
runs in offline mode by default so tests are fast and deterministic.

## Storage

Per-project blobs live under \`data/uploads/<projectId>/\`. Vector tables live
under \`data/lancedb/<projectId>/\`.

### Hashing

We use sha256 for blob deduplication. The hash is split into two-character
buckets so a single project never overflows a directory listing.

## Retrieval

Retrieval is dense-vector cosine similarity for the v1 cut. Hybrid search and
reranking are tracked in follow-up issues.
`;

/**
 * A fixture shaped like METIS's operational documentation, which is where the
 * tiling defect bit hardest.
 *
 * Three features are deliberate, and each one is load-bearing:
 *
 *   - **Fenced code blocks with no internal blank line.** `findBoundary` prefers the
 *     *last* `\n\n` anywhere in the window, so a fence longer than the window makes
 *     the blank line *before* the fence the only candidate — a cut a few dozen
 *     characters in, after which the old cursor jumped a full stride.
 *   - **Prose immediately after a closing fence.** The dominant hole in the real
 *     corpus (the pgvector prerequisite, the IRSA explanation, the leader-election
 *     recovery bullets all vanished this way).
 *   - **Long tables**: consecutive rows with no blank line between them, the other
 *     shape with no paragraph break for the boundary search to find.
 *
 * Sections are longer than the largest arm's `chunkSize` so every arm really slides
 * a window rather than emitting one chunk per section.
 */
export const OPS_DOCUMENT = ((): string => {
  const lines: string[] = [
    "# Cluster operations runbook",
    "",
    "This runbook covers provisioning, credential rotation and recovery for a managed cluster.",
    "",
  ];
  for (let s = 1; s <= 4; s += 1) {
    lines.push(`## Stage ${s} — provisioning and verification`, "");
    lines.push("```bash");
    for (let i = 0; i < 44; i += 1) {
      lines.push(
        `kubectl apply -f stage${s}/manifest-${i}.yaml --namespace metis-stage-${s}-slot-${i}`,
      );
    }
    lines.push("```", "");
    // Prose that follows a fence — the dominant hole shape in the real corpus.
    for (let i = 0; i < 14; i += 1) {
      lines.push(
        `Stage ${s} prerequisite ${i}: the operator must confirm that quota class ${s}-${i} is provisioned before the reconciler is allowed to proceed.`,
      );
    }
    lines.push("");
    lines.push(`| setting | default | stage ${s} value | notes |`, "|---|---|---|---|");
    for (let i = 0; i < 34; i += 1) {
      lines.push(
        `| stage${s}.setting${i} | ${i * 7} | ${i * 11} | applies to reconciler shard ${s}-${i} of the provisioning pool |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
})();

/**
 * `chunkMarkdown(OPS_DOCUMENT, { chunkSize: 2048, overlap: 256 })` as `origin/main`
 * produced it at 18e5d89c, i.e. BEFORE #1185.
 *
 * Literals rather than a recomputation, so the no-op claim is checkable against
 * something outside this branch. `length` guards the pin against fixture drift: if
 * `OPS_DOCUMENT` changes the md5s legitimately change too, and this catches that at
 * the cause rather than leaving 21 hashes failing for an unrelated reason.
 */
const SHIPPED_ARM_PIN = {
  length: 33556,
  count: 21,
  md5s:
    "04b29dd6fc3f3f5b0b051154226c3fb3,d1c3b1f490e876ff4a93e053b9d0dbaf," +
    "c80e85dc34b0f21c11f581c945574f04,12a7667c8929098bf0c10eec5179eea4," +
    "d1cf586a5b10208b0d09117a2ddc5b22,90196c4404048397f0bcf7e3d70b6f94," +
    "d3ba4995f1f3e02553ce46c6296b3f60,d7ca7027a8bad40cf460ee27dee2d7d3," +
    "67280ece0010821918e24923fd319880,236c960518e4f218df25b5b1e4c4910c," +
    "b9889af0294711619fe0a161a19c2f5f,0a95174eacafc4df9e8b5e2e59b51542," +
    "05c2ab83968233978f936323963a705c,e606717f454a2a3abf553dfb12da13bb," +
    "ee155eb2967eee0852bb2112ecf34db4,ab09a82e30336d4e884c90c6e50c6830," +
    "04dddb88c0cedee0d84b48f49bc45d26,3d4660c1458d7abea6c6785b4a01c271," +
    "9e314ad9086d2b3b3308cccf5b17d014,b1e7e81406656667490d5a86bf7f066a," +
    "eee628776705162dae8ffece4eb03e97",
} as const;

/** A source line counts as substantive above this many characters. */
const SUBSTANTIVE_MIN_CHARS = 12;

/**
 * Substantive source lines, with heading markers stripped.
 *
 * `chunkMarkdown` re-emits each section's heading with a `#` count equal to the
 * heading DEPTH rather than the level written in the source (`chunker.ts:127-131`),
 * so `#### Deep` under a shallow stack comes back as `## Deep`. Comparing the marker
 * would therefore fail for a reason that has nothing to do with dropped content.
 * The heading TEXT is what has to survive.
 */
function substantiveLines(source: string): string[] {
  const out: string[] = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(trimmed);
    const line = heading ? heading[1] : trimmed;
    if (line.length > SUBSTANTIVE_MIN_CHARS) out.push(line);
  }
  return out;
}

/** Source lines present in no chunk at all. */
function droppedLines(source: string, chunkSize: number, overlap: number): string[] {
  const haystack = chunkMarkdown(source, { chunkSize, overlap })
    .map((c) => c.text)
    .join("\n\n");
  return substantiveLines(source).filter((line) => !haystack.includes(line));
}

/** Longest suffix of `a` that is also a prefix of `b`. */
function sharedRun(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  for (let n = max; n > 0; n -= 1) {
    if (a.endsWith(b.slice(0, n))) return n;
  }
  return 0;
}

/**
 * Mean characters adjacent chunks of the SAME section actually share.
 *
 * Section-initial chunks are excluded: the window restarts at every heading, so a
 * chunk that begins a section has no predecessor to carry over from and a 0 there
 * would be arithmetic, not evidence. Two consecutive sections in
 * {@link OPS_DOCUMENT} never carry the same heading trail, so comparing the trails
 * identifies continuations exactly.
 */
function meanRealisedOverlap(source: string, chunkSize: number, overlap: number): number {
  const chunks = chunkMarkdown(source, { chunkSize, overlap });
  const runs: number[] = [];
  for (let i = 1; i < chunks.length; i += 1) {
    const same =
      chunks[i].headings.length === chunks[i - 1].headings.length &&
      chunks[i].headings.every((h, j) => h === chunks[i - 1].headings[j]);
    if (same) runs.push(sharedRun(chunks[i - 1].text, chunks[i].text));
  }
  if (runs.length === 0) return 0;
  return runs.reduce((a, b) => a + b, 0) / runs.length;
}

describe("chunkMarkdown", () => {
  it("returns [] for empty / whitespace-only documents", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n\n  \t  ")).toEqual([]);
  });

  it("chunks a single short paragraph into one chunk with empty headings", () => {
    const chunks = chunkMarkdown("just a plain note.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("just a plain note.");
    expect(chunks[0].headings).toEqual([]);
    expect(chunks[0].position).toBe(0);
    expect(chunks[0].md5).toMatch(/^[a-f0-9]{32}$/);
  });

  it("preserves every heading in the chunk metadata", () => {
    const chunks = chunkMarkdown(SAMPLE, { chunkSize: 200, overlap: 32 });
    const headings = new Set(chunks.flatMap((c) => c.headings));
    expect(headings.has("Architecture")).toBe(true);
    expect(headings.has("Storage")).toBe(true);
    expect(headings.has("Hashing")).toBe(true);
    expect(headings.has("Retrieval")).toBe(true);
  });

  it("round-trips the benign sample: every heading and word appears in some chunk", () => {
    const chunks = chunkMarkdown(SAMPLE, { chunkSize: 200, overlap: 32 });
    const haystack = chunks.map((c) => c.text).join("\n\n");
    for (const heading of ["Architecture", "Storage", "Hashing", "Retrieval"]) {
      expect(haystack).toContain(heading);
    }
    for (const word of ["TypeScript", "Prisma", "sha256", "cosine", "follow-up"]) {
      expect(haystack).toContain(word);
    }
  });

  it("emits stable, monotonically-increasing positions", () => {
    const chunks = chunkMarkdown(SAMPLE, { chunkSize: 200, overlap: 32 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.position).toBe(i));
  });

  it("md5 is deterministic per chunk body", () => {
    const a = chunkMarkdown(SAMPLE, { chunkSize: 200, overlap: 32 });
    const b = chunkMarkdown(SAMPLE, { chunkSize: 200, overlap: 32 });
    expect(a.map((c) => c.md5)).toEqual(b.map((c) => c.md5));
  });

  it("respects the chunkSize cap (within the boundary tolerance)", () => {
    const chunks = chunkMarkdown(SAMPLE, { chunkSize: 100, overlap: 16 });
    for (const c of chunks) {
      // boundary search may push slightly past the cap to land on a sentence end
      expect(c.text.length).toBeLessThanOrEqual(110);
    }
  });

  it("respects a 0-overlap setting without infinite loops", () => {
    const chunks = chunkMarkdown(SAMPLE, { chunkSize: 80, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    // No two consecutive chunks should be byte-identical at overlap=0.
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].text).not.toBe(chunks[i - 1].text);
    }
  });

  it("clamps an absurd overlap to the cap instead of throwing", () => {
    // The clamp-vs-reject decision (#1185), asserted as behaviour: an out-of-range
    // overlap is honoured-with-reduction, never fatal. This used to read
    // "clamps overlap >= chunkSize down to chunkSize-1" and assert only `length > 0`,
    // which every one of clamp / warn / honour would have satisfied.
    expect(() => chunkMarkdown(SAMPLE, { chunkSize: 200, overlap: 9999 })).not.toThrow();
    expect(chunkMarkdown(SAMPLE, { chunkSize: 200, overlap: 9999 })).toEqual(
      chunkMarkdown(SAMPLE, { chunkSize: 200, overlap: maxOverlapFor(200) }),
    );
  });

  it("re-exports chunkDocument as the AC-named alias", () => {
    expect(chunkDocument).toBe(chunkMarkdown);
  });

  it("rejects non-string input loudly", () => {
    // @ts-expect-error - intentional misuse
    expect(() => chunkMarkdown(123)).toThrow(TypeError);
  });

  it("handles a doc with only headings", () => {
    const chunks = chunkMarkdown("# A\n## B\n### C");
    expect(chunks.length).toBeGreaterThan(0);
    const allHeadings = chunks.flatMap((c) => c.headings);
    expect(allHeadings).toContain("A");
    expect(allHeadings).toContain("B");
    expect(allHeadings).toContain("C");
  });

  it("handles documents with no headings (single untitled section)", () => {
    const text = "para one.\n\npara two.\n\npara three.";
    const chunks = chunkMarkdown(text, { chunkSize: 64, overlap: 8 });
    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach((c) => expect(c.headings).toEqual([]));
  });
});

/**
 * #1178 — the module header's round-trip claim, asserted for real.
 *
 * Every one of these fails on the pre-#1178 chunker and passes after it, which is
 * the only property that makes them worth having; the check was run by reverting
 * `sliceSection`'s cursor advance and confirming red.
 */
describe("chunkMarkdown tiles its input", () => {
  it.each(CHUNK_SIZE_ARMS.map((a) => [a.id, a.chunkSize, a.overlap] as const))(
    "leaves no substantive source line out of every chunk at %s",
    (_id, chunkSize, overlap) => {
      const dropped = droppedLines(OPS_DOCUMENT, chunkSize, overlap);
      expect(dropped, `${dropped.length} line(s) absent from every chunk`).toEqual([]);
    },
  );

  it("tiles a document whose only paragraph break is at the very start", () => {
    // The minimal reproduction from #1178: one short paragraph, then unbroken rows.
    // The boundary search cut at the single blank line 22 characters in, and the
    // cursor then jumped a full stride, so 47 of 200 rows appeared in no chunk.
    const rows = Array.from({ length: 200 }, (_, i) => `| row ${i} | value ${i * 3} | note ${i} |`);
    const doc = `intro paragraph here.\n\n${rows.join("\n")}`;
    expect(droppedLines(doc, 1024, 128)).toEqual([]);
  });

  it("tiles a section with no whitespace at all to break on", () => {
    // No paragraph break, no sentence terminator, no space: `findBoundary` falls all
    // the way through to the hard cut, which must still tile. This one does NOT
    // discriminate the #1178 fix — a hard cut lands at `cursor + chunkSize`, where
    // the old stride and `sliceEnd - overlap` coincide — so it is a termination and
    // hard-cut-path guard, not evidence of tiling. Kept for that, labelled honestly.
    const doc = `# Solid\n\n${"abcdefghij".repeat(600)}`;
    const chunks = chunkMarkdown(doc, { chunkSize: 512, overlap: 64 });
    const joined = chunks.map((c) => c.text).join("");
    expect(joined.replace(/[^a-j]/g, "").length).toBeGreaterThanOrEqual(6000);
  });

  /**
   * The degenerate input MIN_BOUNDARY_FRACTION exists for.
   *
   * Each of these has its last paragraph break near the START of the first window and
   * nothing to break on afterwards. Without the floor — the naive "just resume at
   * `sliceEnd - overlap`" repair — the window advances ONE character per iteration on
   * all three, spinning out a long tail of near-identical fragments and terminating
   * only because `sliceSection` clamps to `cursor + 1`.
   *
   * Asserting a minimum mean advance rather than a chunk count states the property
   * directly: the window must make real progress, not merely progress.
   */
  it.each([
    [
      "a table with one leading paragraph",
      `intro paragraph here.\n\n${Array.from({ length: 200 }, (_, i) => `| row ${i} | value ${i * 3} | note ${i} |`).join("\n")}`,
    ],
    [
      "a fence longer than the window",
      `# Ops\n\n\`\`\`bash\n${Array.from({ length: 60 }, (_, i) => `kubectl apply -f manifest-${i}.yaml --namespace metis-${i}`).join("\n")}\n\`\`\`\n`,
    ],
    [
      "a table with no blank line inside",
      `# T\n\n| a | b |\n|---|---|\n${Array.from({ length: 120 }, (_, i) => `| cell${i} | value${i} |`).join("\n")}`,
    ],
  ])("advances the window by a real fraction of the stride on %s", (_label, doc) => {
    const chunkSize = 1024;
    const overlap = 128;
    const chunks = chunkMarkdown(doc, { chunkSize, overlap });
    expect(chunks.length).toBeGreaterThan(1);
    const advances: number[] = [];
    for (let i = 1; i < chunks.length; i += 1) {
      advances.push(chunks[i].startOffset - chunks[i - 1].startOffset);
    }
    // Every step strictly forward — the termination property.
    expect(Math.min(...advances)).toBeGreaterThan(0);
    // …and forward by more than a token amount. The unguarded chunker scores 1 here.
    const mean = advances.reduce((a, b) => a + b, 0) / advances.length;
    expect(mean, `mean advance ${mean} chars`).toBeGreaterThan((chunkSize - overlap) / 2);
  });

  // The EFFECTIVE overlap, not the requested one. Since #1184 the size arms request a
  // constant 256 and `size-768` runs at the cap of 192 (#1185); asserting against the
  // request would charge the clamp to the chunker's tiling — the #1183 denominator
  // defect, in a test rather than in a report.
  it.each(
    CHUNK_SIZE_ARMS.map(
      (a) => [a.id, a.chunkSize, armOverlap(a.chunkSize, a.overlap).effective] as const,
    ),
  )("delivers the configured overlap between adjacent chunks at %s", (_id, chunkSize, overlap) => {
    // The second consequence of the same line, and the more sensitive regression
    // check: before #1178 the corpus-wide realised overlap was ~2% of configured,
    // because carry-over happened only when `findBoundary` cut inside the final
    // `overlap` characters. A boundary cut trims at most the two characters of a
    // "\n\n", so the realised run sits just under the configured value.
    const mean = meanRealisedOverlap(OPS_DOCUMENT, chunkSize, overlap);
    expect(mean).toBeGreaterThanOrEqual(overlap * 0.9);
    expect(mean).toBeLessThanOrEqual(overlap);
  });

  it("never advances the window past the end of the chunk it just emitted", () => {
    // The invariant behind both properties above, stated on offsets rather than on
    // its consequences: `startOffset` is exact (`section.startOffset + cursor`), so a
    // successor starting beyond its predecessor's end IS the gap. `endOffset` is
    // computed after a `trim()` and so understates the chunk's extent by the few
    // characters of a "\n\n" — a tolerance far smaller than the 1,792-character
    // stride the defect produced, so the check still discriminates.
    const chunks = chunkMarkdown(OPS_DOCUMENT, { chunkSize: 2048, overlap: 256 });
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1];
      const next = chunks[i];
      // A section restarts the window, so only same-section successors are continuations.
      const sameSection =
        next.headings.length === prev.headings.length &&
        next.headings.every((h, j) => h === prev.headings[j]);
      if (!sameSection) continue;
      expect(next.startOffset, `chunk ${i} starts after chunk ${i - 1} ends`).toBeLessThanOrEqual(
        prev.endOffset,
      );
    }
  });
});

/**
 * #1185 — the window's guaranteed advance, as a property rather than a comment.
 *
 * Tiling (above) says the window never skips content. This block says the window moves
 * a REAL distance every iteration, which is the other half of "makes progress" and the
 * half `overlap` could defeat from configuration alone: `overlap` was bounded only by
 * `chunkSize - 1`, and `RAG_CHUNK_OVERLAP` is env-settable.
 *
 * These are written to fail on a regression rather than to describe one. The
 * discriminating checks are the SPACE sweep (every reachable option pair, not a
 * hand-picked few), the formula-vs-offsets check (the arithmetic has to predict what
 * the loop actually does, so it cannot drift into decoration), and the blow-up bound
 * (the end-to-end consequence, which is ~470× off on the pre-#1185 chunker).
 */
describe("the window's guaranteed advance", () => {
  /** Same-section consecutive `startOffset` deltas — one loop iteration each. */
  function observedAdvances(source: string, chunkSize: number, overlap: number): number[] {
    const chunks = chunkMarkdown(source, { chunkSize, overlap });
    const out: number[] = [];
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1];
      const next = chunks[i];
      const sameSection =
        next.headings.length === prev.headings.length &&
        next.headings.every((h, j) => h === prev.headings[j]);
      if (sameSection) out.push(next.startOffset - prev.startOffset);
    }
    return out;
  }

  /**
   * Inputs with nothing for `findBoundary` to break on late in the window, which is
   * where the advance is at its worst — the same three shapes #1178 used.
   */
  const DEGENERATE: [string, string][] = [
    [
      "a table with one leading paragraph",
      `intro paragraph here.\n\n${Array.from({ length: 400 }, (_, i) => `| row ${i} | value ${i * 3} | note ${i} |`).join("\n")}`,
    ],
    [
      "a fence longer than the window",
      `# Ops\n\n\`\`\`bash\n${Array.from({ length: 200 }, (_, i) => `kubectl apply -f manifest-${i}.yaml --namespace metis-${i}`).join("\n")}\n\`\`\`\n`,
    ],
    ["an unbroken run with no whitespace at all", `# Solid\n\n${"abcdefghij".repeat(2000)}`],
  ];

  it("cannot be driven below a quarter of chunkSize by ANY overlap a caller can pass", () => {
    // The property, swept over the reachable option space rather than sampled at a
    // couple of friendly points. `resolveChunkParams` is the only way into the loop,
    // so quantifying over its output quantifies over every reachable configuration.
    // Loosening the cap to #1185's proposed `chunkSize / 2` fails this at the cap
    // itself, and removing the cap fails it almost everywhere.
    for (const chunkSize of [64, 65, 100, 200, 768, 1023, 1024, 2048, 2049, 3072]) {
      for (const overlap of [
        0,
        1,
        7,
        maxOverlapFor(chunkSize) - 1,
        maxOverlapFor(chunkSize),
        maxOverlapFor(chunkSize) + 1,
        Math.ceil(chunkSize / 2) - 1,
        Math.ceil(chunkSize / 2),
        chunkSize - 1,
        chunkSize,
        chunkSize * 4,
        Number.MAX_SAFE_INTEGER,
      ]) {
        const r = resolveChunkParams({ chunkSize, overlap });
        const advance = guaranteedAdvance(r.chunkSize, r.overlap);
        expect(
          advance,
          `chunkSize ${chunkSize}, requested overlap ${overlap} → effective ${r.overlap}`,
        ).toBeGreaterThanOrEqual(r.chunkSize / 4);
        // The self-describing form of the same bound: never carry over more than you advance.
        expect(r.overlap).toBeLessThanOrEqual(advance);
      }
    }
  });

  it.each(DEGENERATE)("predicts the offsets a real chunking produces on %s", (_label, doc) => {
    // Ties the formula to the loop. `guaranteedAdvance` is only worth asserting if it
    // is a lower bound on what `sliceSection` actually does; if a future edit changes
    // the cursor advance or the boundary floor without updating the formula, the two
    // part company here rather than in a comment.
    for (const [chunkSize, overlap] of [
      [1024, 128],
      [2048, 256],
      [1024, maxOverlapFor(1024)],
      [2048, maxOverlapFor(2048)],
    ] as const) {
      const advances = observedAdvances(doc, chunkSize, overlap);
      expect(advances.length).toBeGreaterThan(1);
      const predicted = guaranteedAdvance(chunkSize, overlap);
      expect(
        Math.min(...advances),
        `${chunkSize}/${overlap}: min observed advance vs predicted ${predicted}`,
      ).toBeGreaterThanOrEqual(predicted);
    }
  });

  it("pins the advance either side of the cap, and at the boundary #1185 proposed", () => {
    // The AC's boundary pin, and the reason the obvious fix was not taken. At
    // chunkSize 2048 the boundary floor is 1024, so an overlap of 1024 — #1185's
    // proposed `floor(chunkSize / 2)` cap — makes `overlap + 1` win the `max` and the
    // advance is exactly 1. Capping at half the floor instead lands the worst case at
    // 512. Both parities, because 2049 behaves the same way.
    expect(guaranteedAdvance(2048, 511)).toBe(513);
    expect(guaranteedAdvance(2048, 512)).toBe(512);
    expect(guaranteedAdvance(2048, 513)).toBe(511);
    expect(guaranteedAdvance(2048, 1023)).toBe(1);
    expect(guaranteedAdvance(2048, 1024)).toBe(1);
    expect(guaranteedAdvance(2049, 1024)).toBe(1);
    expect(guaranteedAdvance(1024, 512)).toBe(1);

    // …and the cap is what puts those pairs out of reach.
    expect(maxOverlapFor(2048)).toBe(512);
    expect(maxOverlapFor(2049)).toBe(512);
    expect(maxOverlapFor(1024)).toBe(256);
    expect(resolveChunkParams({ chunkSize: 2048, overlap: 1024 }).overlap).toBe(512);
    expect(resolveChunkParams({ chunkSize: 1024, overlap: 512 }).overlap).toBe(256);
  });

  it("bounds the output of the catastrophic corner instead of emitting 470x the source", () => {
    // The consequence, end to end. On the pre-#1185 chunker 2048/2047 turned
    // `docs/ARCHITECTURE.md` into 222,917 chunks and 456 MB — 469x the shipped
    // configuration's 475 chunks — and the ingest path embeds every one. Asserting a
    // RATIO against the shipped arm keeps this readable if the fixture ever changes.
    const shipped = chunkMarkdown(OPS_DOCUMENT, { chunkSize: 2048, overlap: 256 }).length;
    for (const overlap of [1023, 1024, 2047]) {
      const n = chunkMarkdown(OPS_DOCUMENT, { chunkSize: 2048, overlap }).length;
      expect(n, `2048/${overlap} emitted ${n} chunks vs ${shipped} shipped`).toBeLessThanOrEqual(
        shipped * 3,
      );
    }
    const emitted = chunkMarkdown(OPS_DOCUMENT, { chunkSize: 2048, overlap: 2047 }).reduce(
      (n, c) => n + c.text.length,
      0,
    );
    expect(emitted).toBeLessThanOrEqual(OPS_DOCUMENT.length * 2);
  });

  it("leaves the shipped 2048/256 configuration byte-identical", () => {
    // The AC's no-op pin. These are literals measured on `origin/main` at
    // 18e5d89c, so they hold this change to "changes nothing anybody actually runs"
    // rather than to "changes nothing, computed the same way twice".
    expect(OPS_DOCUMENT).toHaveLength(SHIPPED_ARM_PIN.length);
    const chunks = chunkMarkdown(OPS_DOCUMENT, { chunkSize: 2048, overlap: 256 });
    expect(chunks).toHaveLength(SHIPPED_ARM_PIN.count);
    expect(chunks.map((c) => c.md5).join(",")).toBe(SHIPPED_ARM_PIN.md5s);
    // And the default options resolve to the shipped pair in the first place.
    expect(resolveChunkParams({})).toMatchObject({ chunkSize: 2048, overlap: 256 });
    expect(chunkMarkdown(OPS_DOCUMENT)).toEqual(chunks);
  });

  it("reports what it did to the caller's request", () => {
    // The programmatic half of the clamp decision: a caller that wants to know, can.
    expect(resolveChunkParams({ chunkSize: 2048, overlap: 1500 })).toEqual({
      chunkSize: 2048,
      overlap: 512,
      requestedOverlap: 1500,
      maxOverlap: 512,
    });
    expect(resolveChunkParams({ chunkSize: 2048, overlap: 256 })).toMatchObject({
      overlap: 256,
      requestedOverlap: 256,
    });
  });

  it("normalises degenerate options rather than emitting nothing", () => {
    // A non-finite chunkSize used to propagate NaN through `end`/`sliceEnd` and return
    // ZERO chunks — silent total loss of the document; a non-finite overlap truncated
    // it to one. Both are the same out-of-range-option question this issue is about,
    // so they are answered the same way: fall back, do not fail and do not drop.
    expect(resolveChunkParams({ chunkSize: Number.NaN })).toMatchObject({ chunkSize: 2048 });
    expect(resolveChunkParams({ overlap: Number.NaN })).toMatchObject({ overlap: 256 });
    expect(chunkMarkdown(OPS_DOCUMENT, { chunkSize: Number.NaN }).length).toBeGreaterThan(1);
    expect(chunkMarkdown(OPS_DOCUMENT, { overlap: Number.NaN }).length).toBeGreaterThan(1);
    // Below the floor, negative, and fractional.
    expect(resolveChunkParams({ chunkSize: 1, overlap: -5 })).toMatchObject({
      chunkSize: 64,
      overlap: 0,
    });
    expect(resolveChunkParams({ chunkSize: 2048.9, overlap: 100.9 })).toMatchObject({
      chunkSize: 2048,
      overlap: 100,
    });
  });

  it("is idempotent, so re-resolving an already-resolved pair is a no-op", () => {
    // `KnowledgeService` resolves at construction and `chunkMarkdown` resolves again
    // per call. If that were not a fixed point the effective overlap would shrink on
    // every hop.
    for (const opts of [{}, { chunkSize: 2048, overlap: 9999 }, { chunkSize: 1, overlap: -1 }]) {
      const once = resolveChunkParams(opts);
      expect(resolveChunkParams(once)).toEqual({ ...once, requestedOverlap: once.overlap });
    }
  });
});

describe("a window that is entirely whitespace emits no chunk", () => {
  // `sliceSection` drops a slice that trims to empty rather than pushing a blank
  // chunk. Reachable whenever a section carries a whitespace run longer than one
  // window: the space tier cuts inside the run, so the whole slice is whitespace.
  // Worth pinning because the alternative — emitting it — would put empty rows in
  // `knowledge_chunks` and embed them, and nothing downstream filters for that.
  const pad = " ".repeat(400);
  const doc = `# Heading\n\nstart${pad}middle${pad}end`;

  it("emits only the substantive chunks, and none of them is blank", () => {
    const chunks = chunkMarkdown(doc, { chunkSize: 64, overlap: 4 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.text.trim()).not.toBe("");
      expect(c.text).toBe(c.text.trim());
    }
  });

  it("skips more windows than it emits, so the guard is actually exercised", () => {
    // Without this the test above passes vacuously on a document with no
    // whitespace-only window at all.
    const chunks = chunkMarkdown(doc, { chunkSize: 64, overlap: 4 });
    const windowsWalked = Math.ceil(doc.length / 64);
    expect(chunks.length).toBeLessThan(windowsWalked);
  });
});
