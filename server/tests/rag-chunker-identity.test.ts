/**
 * Issue #1182 — the chunker-generation tag, and the gate that keeps it honest.
 *
 * `KnowledgeChunk.chunkerIdentity` exists so a store holding two chunker
 * generations is visible rather than silent. That only works if the identity
 * actually changes when the chunking changes, and the failure mode is quiet in
 * both directions:
 *
 *   - change a boundary rule and forget to bump `CHUNKER_ALGORITHM_VERSION`, and
 *     every row keeps a tag that claims a chunking it no longer has;
 *   - bump the version with nothing to show for it, and every existing row is
 *     reported as drifted and operators are sent into a re-ingest for nothing.
 *
 * The boundary-signature pin below closes the first; requiring the active version
 * to have a recorded signature closes the second. Both are proven by mutation in
 * PR #1182 — see its body for the commands and the observed failures.
 */
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BOUNDARY_TIERS,
  CHUNKER_ALGORITHM_VERSION,
  chunkMarkdown,
  chunkerIdentity,
  chunkerProducerOf,
  classifyChunkerIdentity,
  DOCUMENT_CHUNKER_PRODUCER,
  findBoundary,
  maxOverlapFor,
} from "../src/lib/rag/chunker.js";
import { DOCSGEN_CHUNKER_IDENTITY } from "../src/lib/docs-gen/rag-ingest.js";

/**
 * The four arms the chunk-size sweep uses (#1160), pinned here rather than
 * imported: this gate must not move when the eval harness's arms do.
 */
const ARMS: Array<{ chunkSize: number; overlap: number }> = [
  { chunkSize: 768, overlap: 96 },
  { chunkSize: 1024, overlap: 128 },
  { chunkSize: 2048, overlap: 256 },
  { chunkSize: 3072, overlap: 384 },
];

/**
 * One shape per boundary tier, because a pin is only as sensitive as its fixture.
 *
 * `findBoundary` tries paragraph break → line end → sentence terminator → space →
 * hard cut, stopping at the first tier with a candidate at or after the floor. Any
 * tier the fixture never reaches is a tier this pin cannot see.
 *
 * **This was wrong three times, every time measured rather than reasoned, and the
 * third is why this file no longer relies on the fixture alone.**
 *
 *   1. The first fixture was table- and fence-only, so the LINE tier always won:
 *      adding `"; "` to `SENTENCE_ENDS` moved no boundary and the arm passed.
 *   2. Adding an unbroken prose run fixed the sentence tier — and PR #1182's review
 *      panel then counted the tier hits and found paragraph 0, line 41, sentence 20,
 *      space 0, hard-cut 0. Three of five tiers were dormant.
 *   3. Reaching a tier was then used as the proxy for pinning it, and they are not
 *      the same property. With the paragraphs built as single lines, the paragraph
 *      tier won 24 times and **all 24** returned the offset the line tier would have
 *      returned anyway, so deleting the tier — or demoting it below the line tier —
 *      left the digest byte-identical. A tier is pinned only if REMOVING it changes
 *      the digest.
 *
 * Both halves of the answer live below. The fixture's paragraphs are hard-wrapped so
 * the tiers can disagree, and — because a fixture is only ever evidence about the
 * fixture — "every tier is load-bearing" is asserted mechanically against
 * `BOUNDARY_TIERS` rather than claimed in prose.
 *
 *   - hard-wrapped blank-line-separated paragraphs → paragraph tier
 *   - a 120-row table with no blank line           → line tier
 *   - an unbroken run of sentences                 → sentence tier
 *   - multi-sentence lines ending in "\n"          → line ABOVE sentence
 *   - an unbroken run with NO sentence marks       → space tier
 *   - an unbroken run with no spaces at all        → hard cut
 *
 * Plus the mid-line periods a naive sentence tier cuts on (`e.g.`, `v1.2.3`,
 * `#849`), which are what #1178's line-tier promotion exists to outrank.
 */
function fixture(): string {
  const rows = Array.from(
    { length: 120 },
    (_, i) => `| row-${i} | value-${i} | a moderately long cell body for row ${i} | ok |`,
  ).join("\n");
  const fence = Array.from(
    { length: 60 },
    (_, i) => `  const identifier${i} = compute(${i}, "a string argument", { flag: true });`,
  ).join("\n");
  // ONE line, no newline anywhere inside it, long enough to span several windows
  // at every arm. This is the only shape that reaches the sentence and space
  // tiers, and it mixes the separators those tiers disagree about.
  const unbrokenProse = Array.from(
    { length: 40 },
    (_, i) =>
      `Sentence ${i} explains a thing at some length; it carries a semicolon clause too, ` +
      `and it ends properly. Then another clause follows! And a question? Yes.`,
  ).join(" ");
  // Paragraphs long enough that a blank line lands PAST the boundary floor (half
  // the window) even at the 3072 arm, and a section long enough to need several
  // windows. Without this the paragraph tier — the commonest boundary in real
  // markdown — is never taken.
  //
  // Each paragraph is HARD-WRAPPED over several lines, and that detail is the whole
  // point of this shape. The first version built each paragraph as a single line
  // joined by "\n\n", so in every window the last "\n\n" at index i forced
  // `lastIndexOf("\n")` to return i + 1 and the paragraph tier's `from + i + 2` was
  // byte-identical to the line tier's `from + (i + 1) + 1`. The tier was reached 24
  // times and pinned zero of them: PR #1182's review panel deleted it, and separately
  // demoted it below the line tier, and the digest did not move for either. Wrapping
  // the paragraphs puts the last "\n" well after the last "\n\n", which is the shape
  // ordinary markdown prose has, and the two tiers then disagree.
  const longParagraphs = Array.from({ length: 14 }, (_, i) =>
    Array.from(
      { length: 8 },
      (_, j) =>
        `Paragraph ${i} line ${j} carries enough ordinary prose to read as a realistic ` +
        `hard-wrapped line rather than a contrived one.`,
    ).join("\n"),
  ).join("\n\n");
  // Lines that each hold SEVERAL sentences and end with a newline, no blank lines.
  //
  // This shape exists because the per-tier gate below found it missing, which is the
  // third fixture hole in this file and the second found by mutating rather than
  // reasoning. Transposing the line and sentence tiers changed no boundary in 1,894
  // swept windows, because no other shape here puts a line end AND a later mid-line
  // sentence terminator both past the floor: the table rows end in `|`, the fence
  // lines in `;`, the wrapped paragraphs end each line with `".\n"` — which is not
  // `". "` and so is invisible to SENTENCE_ENDS — and the unbroken prose run has no
  // newline at all. Here the window commonly ends part-way through a line, so the
  // last `"\n"` sits at the previous line break and the last `". "` sits after it,
  // and the two tiers return different offsets.
  const multiSentenceLines = Array.from(
    { length: 60 },
    (_, i) =>
      `Line ${i} opens with a claim about the subject. It follows with a second ` +
      `sentence that runs on for a while. A third sentence closes it out at a ` +
      `comfortable width. Done with line ${i}.`,
  ).join("\n");
  // No sentence terminator and no newline anywhere — the space tier is the first
  // candidate the search can accept.
  const noSentenceMarks = Array.from({ length: 700 }, (_, i) => `token${i}`).join(" ");
  // No spaces either, so every tier fails its floor and the hard cut is taken.
  const unbrokenToken = "x".repeat(9000);
  // #201 — non-ASCII text, bounded by UTF-8 bytes as well as characters. Short
  // Japanese lines (3 bytes a character) and one unbroken emoji run (4 bytes a
  // code point, 2 UTF-16 units): at every arm a character window of this holds
  // more than EMBED_INPUT_MAX_BYTES, so v2 and v3 cut it differently.
  const nonAscii = [
    ...Array.from(
      { length: 40 },
      (_, i) => `第${i}行：検索拡張生成は文書の内容を理解するための仕組みです。`,
    ),
    "😀🚀🎉🧪".repeat(400),
  ].join("\n");
  return [
    "# Heading one",
    "",
    "Prose that mentions v1.2.3 and (e.g. this) and (#849). It runs on for a while so that",
    "the window has something to cut inside of, and it contains no blank lines at all.",
    "",
    "## A table",
    "",
    "| a | b | c | d |",
    "| --- | --- | --- | --- |",
    rows,
    "",
    "## A fenced block",
    "",
    "```ts",
    fence,
    "```",
    "",
    "## Unbroken prose",
    "",
    unbrokenProse,
    "",
    "## Long paragraphs",
    "",
    longParagraphs,
    "",
    "## Multi-sentence lines",
    "",
    multiSentenceLines,
    "",
    "## No sentence marks",
    "",
    noSentenceMarks,
    "",
    "## One long token",
    "",
    unbrokenToken,
    "",
    "## Non-ASCII",
    "",
    nonAscii,
    "",
    "### Short section",
    "",
    "This one fits in a single chunk at every arm.",
    "",
  ].join("\n");
}

/**
 * A digest of WHERE the chunker cut, not of what it happened to emit. Offsets and
 * body hashes together: two chunkings that agree on both are the same chunking.
 */
function boundarySignature(): string {
  const parts: string[] = [];
  for (const arm of ARMS) {
    parts.push(`@${arm.chunkSize}/${arm.overlap}`);
    for (const c of chunkMarkdown(fixture(), arm)) {
      parts.push(`${c.position}:${c.startOffset}:${c.endOffset}:${c.md5}`);
    }
  }
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex");
}

/**
 * The recorded signature of each chunker generation. **Adding an entry here is the
 * deliberate act that accompanies a version bump** — it is where a developer states
 * that they know boundaries moved and that every pre-existing row is now a previous
 * generation.
 *
 * v1 has no entry and never will: it predates the tag, was never written to the
 * database, and its defining property is that `chunkerIdentity` is NULL.
 *
 * **The digest is a function of the chunker AND of `fixture()`**, so editing the
 * fixture moves it without any generation having changed. That case re-records the
 * digest and must NOT bump the version — no stored row is affected by a test fixture.
 * The failure message spells the two cases out, because they are indistinguishable
 * from the diff alone.
 */
const BOUNDARY_SIGNATURES: Record<number, string> = {
  // Re-recorded in #201 for the fixture's new non-ASCII shape, measured with the
  // v2 chunker. Over the pre-#201 fixture, v2 AND v3 both give d31ec718…c7ac0d7aa:
  // v3 moved no ASCII boundary.
  2: "000e23a8232e3655b4035d4fdc68d609d7897efabf31e5875949119b7a3fce08",
  // #201 — non-ASCII chunks are also bounded by UTF-8 bytes.
  3: "36f10113e68ab0737c9ecca58c17e850f2902b6b0ed79bcb0a5278982343436f",
};

describe("issue #1182 — chunker identity", () => {
  it("is composite: producer, algorithm version AND effective parameters", () => {
    expect(chunkerIdentity({ chunkSize: 2048, overlap: 256 })).toBe(
      `${DOCUMENT_CHUNKER_PRODUCER}:v${CHUNKER_ALGORITHM_VERSION}:2048/256`,
    );
  });

  it("carries the algorithm version, so a FUTURE same-parameter change still drifts", () => {
    // Not the #1178 case — that one is separated by NULL-vs-tagged whatever the
    // shape. This is the next one: once both generations carry a tag, a change to
    // the chunker that leaves 2048/256 alone (exactly what #1178 was) is invisible
    // unless the version is in the string.
    const identity = chunkerIdentity({ chunkSize: 2048, overlap: 256 });
    expect(identity).toContain(`:v${CHUNKER_ALGORITHM_VERSION}:`);
    expect(identity).not.toBe("2048/256");
    expect(identity).not.toBe(`${DOCUMENT_CHUNKER_PRODUCER}:2048/256`);
  });

  it("uses the EFFECTIVE overlap, so a request above the cap is not a false drift", () => {
    // #1185 caps overlap at a quarter of chunkSize. 1500 and 512 produce
    // byte-identical chunks at 2048, so they must produce identical tags — a
    // spurious drift would send an operator into a re-ingest that changes nothing.
    expect(maxOverlapFor(2048)).toBe(512);
    expect(chunkerIdentity({ chunkSize: 2048, overlap: 1500 })).toBe(
      chunkerIdentity({ chunkSize: 2048, overlap: 512 }),
    );
  });

  it("uses the normalised chunk size, so a sub-minimum request is not a false drift", () => {
    // `normaliseChunkSize` raises anything below MIN_CHUNK_SIZE (64) to 64.
    expect(chunkerIdentity({ chunkSize: 10, overlap: 4 })).toBe(
      chunkerIdentity({ chunkSize: 64, overlap: 4 }),
    );
  });

  it("differs when the parameters differ", () => {
    expect(chunkerIdentity({ chunkSize: 1024, overlap: 128 })).not.toBe(
      chunkerIdentity({ chunkSize: 2048, overlap: 256 }),
    );
  });

  it("defaults to the shipped configuration", () => {
    expect(chunkerIdentity()).toBe(
      `${DOCUMENT_CHUNKER_PRODUCER}:v${CHUNKER_ALGORITHM_VERSION}:2048/256`,
    );
  });
});

/**
 * Issue #1182 — the four-way classification, and specifically that a FOREIGN
 * producer is not drift.
 *
 * `docs-gen/rag-ingest.ts` is a second `knowledge_chunks` writer with its own
 * 1,500-character chunker. Its rows are that chunker's correct output, not a stale
 * generation of this one, and no re-ingest of the document chunker will ever change
 * them. Classifying them as drift pinned `embeddings:migrate status` at exit 3
 * permanently — measured during PR #1182's review at 103 of 1,415 rows across 2 of 3
 * projects — prescribing a remedy that could not clear it.
 */
describe("issue #1182 — classifyChunkerIdentity", () => {
  const ACTIVE = chunkerIdentity({ chunkSize: 2048, overlap: 256 });

  it("classifies the active identity as current", () => {
    expect(classifyChunkerIdentity(ACTIVE, ACTIVE)).toBe("current");
  });

  it("classifies NULL as untagged — the unknown case must NOT default to fine", () => {
    // Every pre-#1178 row is in here. Defaulting the unknown case to "current" is
    // exactly how a gate ships already open.
    expect(classifyChunkerIdentity(null, ACTIVE)).toBe("untagged");
    expect(classifyChunkerIdentity(undefined, ACTIVE)).toBe("untagged");
    expect(classifyChunkerIdentity("", ACTIVE)).toBe("untagged");
  });

  it("classifies a superseded generation of the SAME producer as drifted", () => {
    expect(classifyChunkerIdentity("doc:v1:2048/256", ACTIVE)).toBe("drifted");
    expect(classifyChunkerIdentity("doc:v2:1024/128", ACTIVE)).toBe("drifted");
  });

  it("classifies another producer as foreign, not drifted", () => {
    expect(classifyChunkerIdentity(DOCSGEN_CHUNKER_IDENTITY, ACTIVE)).toBe("foreign");
    expect(classifyChunkerIdentity("someother:v9:10", ACTIVE)).toBe("foreign");
  });

  it("classifies a value with NO producer segment as untagged, not foreign", () => {
    // The two unknown cases must fail in opposite directions on purpose: a NAMED
    // foreign producer is excluded from the verdict because we know what it is and
    // decided not to track it, but a separator-less value claims nothing and can only
    // come from corruption or a bug, so it must be counted as outstanding. Routing it
    // into `foreign` — as the first draft did — bought it silence.
    expect(classifyChunkerIdentity("noseparator", ACTIVE)).toBe("untagged");
    expect(classifyChunkerIdentity(":v2:2048/256", ACTIVE)).toBe("untagged");
  });

  it("splits the producer on the FIRST separator, never by prefix", () => {
    // `doc`.startsWith-style matching would swallow `docsgen` into the document
    // producer and re-introduce the bug — the substring-vs-segment confusion that
    // de-gated a path check in #1172.
    expect(chunkerProducerOf(DOCSGEN_CHUNKER_IDENTITY)).toBe("docsgen");
    expect(chunkerProducerOf(ACTIVE)).toBe(DOCUMENT_CHUNKER_PRODUCER);
    expect(chunkerProducerOf("noseparator")).toBe("");
    expect(DOCSGEN_CHUNKER_IDENTITY.startsWith(DOCUMENT_CHUNKER_PRODUCER)).toBe(true);
    expect(classifyChunkerIdentity(DOCSGEN_CHUNKER_IDENTITY, ACTIVE)).not.toBe("drifted");
  });
});

/**
 * Issue #1182 — every boundary tier is LOAD-BEARING: its existence and its place in
 * the order both change where the chunker cuts.
 *
 * The digest pin below is a pin on one fixed chunker, so it can only ever see a tier
 * whose *arithmetic* changed. This gate mutates the rule table itself — the same
 * mutation a careless edit to `findBoundary` would make — and requires each mutation
 * to be observable. It is the guard that PR #1182's review panel showed the digest
 * alone was not: with the old fixture, deleting the paragraph tier left 13/13 green.
 *
 * Windows are swept across the fixture at every arm's parameters rather than taken
 * from the chunker's own walk, so the gate stays sensitive if `sliceSection` changes
 * which windows it searches.
 */
describe("issue #1182 — every findBoundary tier is load-bearing", () => {
  const WINDOW_STRIDE = 97;

  interface Window {
    body: string;
    from: number;
    to: number;
    overlap: number;
  }

  const WINDOWS: Window[] = (() => {
    const body = fixture();
    const out: Window[] = [];
    for (const arm of ARMS) {
      for (let from = 0; from + arm.chunkSize <= body.length; from += WINDOW_STRIDE) {
        out.push({ body, from, to: from + arm.chunkSize, overlap: arm.overlap });
      }
    }
    return out;
  })();

  /** How many swept windows the variant tier list cuts differently from production. */
  function differingWindows(tiers: readonly (typeof BOUNDARY_TIERS)[number][]): number {
    let n = 0;
    for (const w of WINDOWS) {
      const base = findBoundary(w.body, w.from, w.to, w.overlap);
      const variant = findBoundary(w.body, w.from, w.to, w.overlap, tiers);
      if (base !== variant) n += 1;
    }
    return n;
  }

  it("sweeps enough windows for the gate below to mean anything", () => {
    // Guards the vacuous pass: every assertion below is `> 0` over this collection,
    // so an empty or tiny sweep would make the whole describe block pass for free.
    expect(WINDOWS.length).toBeGreaterThan(200);
  });

  // DELETE arms — one per tier. Proves the tier EXISTS in the chain, which a digest
  // over a fixed chunker cannot see.
  it.each(BOUNDARY_TIERS.map((t, i) => [t.name, i] as const))(
    "deleting the %s tier moves at least one boundary",
    (name, index) => {
      const without = BOUNDARY_TIERS.filter((_, i) => i !== index);
      expect(
        differingWindows(without),
        `Removing the "${name}" tier from BOUNDARY_TIERS changed no boundary in ` +
          `${WINDOWS.length} windows, so nothing in this file pins its existence. Either the ` +
          `fixture no longer contains a shape only this tier can cut — extend fixture() — or ` +
          `the tier is genuinely redundant and should be deleted from chunker.ts.`,
      ).toBeGreaterThan(0);
    },
  );

  // REORDER arms — one per adjacent pair. Proves PRECEDENCE, which is a separate
  // property from existence: a demoted tier is still present and still reached.
  it.each(
    BOUNDARY_TIERS.slice(0, -1).map((t, i) => [t.name, BOUNDARY_TIERS[i + 1].name, i] as const),
  )("swapping the %s and %s tiers moves at least one boundary", (a, b, index) => {
    const swapped = [...BOUNDARY_TIERS];
    [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    expect(
      differingWindows(swapped),
      `Transposing "${a}" and "${b}" in BOUNDARY_TIERS changed no boundary in ` +
        `${WINDOWS.length} windows, so their relative order is unpinned and a future edit ` +
        `could reorder them silently.`,
    ).toBeGreaterThan(0);
  });

  it("the hard cut is reached — an empty tier list is not equivalent to the real one", () => {
    // The fifth tier is `return to`, which cannot be "deleted" from a function that
    // must return. Its arm is the other direction: windows exist where every tier
    // fails the floor and the hard cut is what production actually takes.
    const hardCuts = WINDOWS.filter(
      (w) => findBoundary(w.body, w.from, w.to, w.overlap) === w.to,
    ).length;
    expect(hardCuts).toBeGreaterThan(0);
    expect(differingWindows([])).toBeGreaterThan(0);
  });
});

describe("issue #1182 — the boundary-signature pin", () => {
  it("the ACTIVE version has a recorded boundary signature", () => {
    // Guards the second direction: bumping the version without recording what the
    // new generation actually produces would make every stored row report as
    // drifted on the strength of a constant nobody measured.
    expect(
      BOUNDARY_SIGNATURES[CHUNKER_ALGORITHM_VERSION],
      `CHUNKER_ALGORITHM_VERSION is ${CHUNKER_ALGORITHM_VERSION} but BOUNDARY_SIGNATURES has no ` +
        `entry for it. Run this test, take the "actual" digest, and record it — that is the ` +
        `step where you confirm the boundaries really did move.`,
    ).toBeDefined();
  });

  it("pins the boundary signature of the active chunker generation", () => {
    // Guards the first direction: any change to chunker.ts that moves a cut for
    // this fixture at any arm fails here.
    expect(
      boundarySignature(),
      `Chunk boundaries moved for this fixture. Two different causes land here:\n` +
        `  (a) you changed fixture() and NOT the chunker — re-record the digest below and ` +
        `do NOT bump the version; no stored row is affected by a test fixture.\n` +
        `  (b) you changed src/lib/rag/chunker.ts — bump CHUNKER_ALGORITHM_VERSION and add ` +
        `the new digest as a NEW entry in BOUNDARY_SIGNATURES. Every row already in the ` +
        `database was produced by the PREVIOUS generation and now needs a re-ingest (NOT a ` +
        `reindex: \`embeddings:migrate reindex\` re-embeds stored chunk text and never ` +
        `re-chunks).\n` +
        `If both, do (b). Check \`git diff src/lib/rag/chunker.ts\` before choosing.`,
    ).toBe(BOUNDARY_SIGNATURES[CHUNKER_ALGORITHM_VERSION]);
  });
});
