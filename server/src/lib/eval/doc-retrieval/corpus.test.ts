import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../../rag/chunker.js";
import { alignChunksToSource, bestCoveringChunk } from "./chunk-alignment.js";
import { CHUNK_SIZE_ARMS } from "./chunk-sweep.js";
import {
  buildCorpusIdf,
  corpusWords,
  DEFAULT_DOC_CORPUS_ID,
  DOC_SNAPSHOT_DIR,
  docCorpusDir,
  idfWeightedQuestionCoverage,
  loadDocRetrievalCorpus,
  longestSharedWordRun,
  MAX_SPAN_CHARS,
  MIN_SPAN_CHARS,
  resolveQueries,
  resolveSpan,
  WIDE_DOC_CORPUS_ID,
  type DocRetrievalQuerySpec,
} from "./corpus.js";

describe("resolveSpan", () => {
  it("returns the character range of a unique quote", () => {
    expect(resolveSpan("alpha beta gamma", "beta", "q1")).toEqual([6, 10]);
  });

  it("throws when the quote is absent — a mistyped anchor must not be silently dropped", () => {
    expect(() => resolveSpan("alpha beta", "delta", "q1")).toThrow(
      /is not a substring of its document/,
    );
  });

  it("throws when the quote occurs twice — an ambiguous anchor is not ground truth", () => {
    expect(() => resolveSpan("beta and beta", "beta", "q1")).toThrow(/occurs more than once/);
  });

  it("names the offending query id so the corpus author can find it", () => {
    expect(() => resolveSpan("alpha", "zeta", "dq-ops-99")).toThrow(/dq-ops-99/);
  });
});

/**
 * The four rejections that stand between a mistyped corpus and a number nobody can
 * trust. Each fails LOUDLY on purpose — silently dropping a query shrinks n without
 * telling anyone, which is the failure mode #1157 was bitten by.
 */
describe("resolveQueries", () => {
  // Every line distinct, so a slice of it is a UNIQUE quote. A filler of repeated
  // characters would trip `resolveSpan`'s ambiguity guard first and each test below
  // would pass on the wrong error.
  const text = Array.from({ length: 60 }, (_, i) => `line ${i} alpha beta gamma`).join("\n");
  const docs = new Map([
    ["a.md", { id: "a.md", text }],
    ["b.md", { id: "b.md", text: text.replace(/alpha/g, "delta") }],
  ]);
  const query = (over: Partial<DocRetrievalQuerySpec> = {}): DocRetrievalQuerySpec => ({
    id: "dq-1",
    question: "what?",
    doc: "a.md",
    quote: text.slice(0, 100),
    phrasing: "lexical",
    ...over,
  });

  it("resolves a well-formed query to absolute offsets", () => {
    const [resolved] = resolveQueries([query()], docs, "c");
    expect(resolved.spanStart).toBe(0);
    expect(resolved.spanEnd).toBe(100);
  });

  it("rejects a query naming a document the snapshot does not contain", () => {
    expect(() => resolveQueries([query({ doc: "missing.md" })], docs, "c")).toThrow(
      /names document "missing.md", which is not in the snapshot/,
    );
  });

  it("names the known documents, so the author can see the typo", () => {
    expect(() => resolveQueries([query({ doc: "A.md" })], docs, "c")).toThrow(/a\.md, b\.md/);
  });

  it("rejects a quote SHORTER than the band — too little of the answer to be relevant", () => {
    expect(() =>
      resolveQueries([query({ quote: "x".repeat(MIN_SPAN_CHARS - 1) })], docs, "c"),
    ).toThrow(new RegExp(`quote is ${MIN_SPAN_CHARS - 1} characters, outside the`));
  });

  /**
   * The load-bearing half: a span longer than the smallest arm's chunk cannot be
   * covered by ONE chunk there, so admitting it would punish the small arms for the
   * corpus's shape rather than for their retrieval quality — an invisible thumb on
   * the scale of the very comparison #1160 exists to make.
   */
  it("rejects a quote LONGER than the band, which would bias the sweep against small arms", () => {
    expect(() =>
      resolveQueries([query({ quote: "x".repeat(MAX_SPAN_CHARS + 1) })], docs, "c"),
    ).toThrow(/punish[\s\S]*small chunks for the corpus's shape/);
  });

  it("rejects a duplicate query id rather than letting one silently overwrite the other", () => {
    expect(() => resolveQueries([query(), query()], docs, "corpus-x")).toThrow(
      /Duplicate query id "dq-1" in corpus-x\/queries\.json/,
    );
  });
});

describe("docCorpusDir", () => {
  it("resolves the default corpus inside eval-data/corpus", () => {
    expect(docCorpusDir()).toMatch(/eval-data\/corpus\/docretrieval-01-metis-docs$/);
  });

  it("inherits the traversal guard from the shared corpus resolver", () => {
    expect(() => docCorpusDir("../../etc")).toThrow(/outside eval-data\/corpus/);
  });
});

describe("the committed corpus", () => {
  it("loads, and every query resolves to a unique span", async () => {
    const corpus = await loadDocRetrievalCorpus();
    expect(corpus.id).toBe(DEFAULT_DOC_CORPUS_ID);
    // Ten when #1160 committed it; nine since one internal document was removed before
    // publication (see WIDE_DOC_CORPUS_ID's docstring).
    expect(corpus.docs.length).toBe(9);
    // #1160 acceptance criterion: at least 40 hand-authored queries.
    expect(corpus.queries.length).toBeGreaterThanOrEqual(40);
    for (const q of corpus.queries) {
      expect(q.spanEnd).toBeGreaterThan(q.spanStart);
      expect(q.spanEnd - q.spanStart).toBe(q.quote.length);
    }
  });

  it("declares a snapshotCommit, so the frozen corpus can be checked against what it CLAIMS", async () => {
    const corpus = await loadDocRetrievalCorpus();
    expect(corpus.snapshotCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps every span inside the band that makes arms comparable", async () => {
    const corpus = await loadDocRetrievalCorpus();
    for (const q of corpus.queries) {
      expect(q.quote.length).toBeGreaterThanOrEqual(MIN_SPAN_CHARS);
      expect(q.quote.length).toBeLessThanOrEqual(MAX_SPAN_CHARS);
    }
  });

  it("carries both phrasing strata, so a lexically-flattered subset can be reported separately", async () => {
    const corpus = await loadDocRetrievalCorpus();
    const counts = { lexical: 0, paraphrase: 0 };
    for (const q of corpus.queries) counts[q.phrasing] += 1;
    expect(counts.lexical).toBeGreaterThan(0);
    expect(counts.paraphrase).toBeGreaterThan(0);
  });

  it("spreads queries over every snapshotted document rather than clustering", async () => {
    const corpus = await loadDocRetrievalCorpus();
    const docsWithQueries = new Set(corpus.queries.map((q) => q.doc));
    expect(docsWithQueries.size).toBe(corpus.docs.length);
  });

  it("uses LF line endings, which the offset alignment assumes", async () => {
    const corpus = await loadDocRetrievalCorpus();
    for (const doc of corpus.docs) expect(doc.text).not.toContain("\r");
  });

  /**
   * THE acceptance criterion of #1160: ground truth anchored to a text span rather
   * than a chunk index does not move when the chunk size moves. The span offsets
   * are a property of the SOURCE DOCUMENT alone, so they are byte-identical at
   * every arm and the corpus needs no edit to be swept.
   */
  it("anchors ground truth to the source, so it is IDENTICAL at all four chunk sizes", async () => {
    const corpus = await loadDocRetrievalCorpus();
    const byDoc = new Map(corpus.docs.map((d) => [d.id, d]));
    for (const q of corpus.queries) {
      const doc = byDoc.get(q.doc);
      expect(doc).toBeDefined();
      // Re-derive the anchor at every arm; nothing about chunking is consulted.
      for (const arm of CHUNK_SIZE_ARMS) {
        chunkMarkdown(doc?.text ?? "", { chunkSize: arm.chunkSize, overlap: arm.overlap });
        const [start, end] = resolveSpan(doc?.text ?? "", q.quote, q.id);
        expect([start, end], `${q.id} at ${arm.id}`).toEqual([q.spanStart, q.spanEnd]);
      }
    }
  });

  /**
   * Derived relevance is EXACTLY one chunk per query at every arm, which is what
   * keeps nDCG@10 denominators comparable between arms.
   *
   * This test used to pin a non-empty set. `chunkMarkdown` did not tile its input, so
   * two answer spans were absent from every chunk at 1024/128 (`dq-eks-05`,
   * `dq-tms-01`) and five at 768/96 (`dq-ops-04`, `dq-ops-05`, `dq-eks-05`,
   * `dq-tok-01`, `dq-dmo-02`) — a production defect the sweep measured rather than
   * hid. #1178 fixed the chunker and every one of those spans came back, so the
   * expectation is now empty at all four arms, which is what the pin existed to
   * detect. Reverting `chunker.ts` to its pre-#1178 state reproduces the two lists
   * above exactly, which is how the fix was confirmed to be the cause rather than a
   * coincidence.
   *
   * The whole change is needed to reproduce them, not the cursor advance alone.
   * Measured: restoring only `cursor = Math.max(cursor + stride, sliceEnd - overlap)`
   * while keeping {@link MIN_BOUNDARY_FRACTION} and the `"\n"` tier leaves this test
   * PASSING — dropped spans stay `[]` at all four arms, and only the substantive-lines
   * test below fails (48 at `size-2048`). The boundary floor and the line tier each
   * carry part of these pins, so attributing them to the cursor advance would credit
   * one of three fixes with all three shares.
   */
  it("derives exactly one relevant chunk per query at every arm — no span is dropped", async () => {
    const corpus = await loadDocRetrievalCorpus();
    const byDoc = new Map(corpus.docs.map((d) => [d.id, d]));
    const droppedByArm: Record<string, string[]> = {};
    for (const arm of CHUNK_SIZE_ARMS) {
      const dropped: string[] = [];
      for (const q of corpus.queries) {
        const text = byDoc.get(q.doc)?.text ?? "";
        const alignedChunks = alignChunksToSource(
          text,
          chunkMarkdown(text, { chunkSize: arm.chunkSize, overlap: arm.overlap }),
        );
        const best = bestCoveringChunk(alignedChunks, q.spanStart, q.spanEnd);
        if (best === null) dropped.push(q.id);
        else expect(best.overlap, `${q.id} at ${arm.id}`).toBeGreaterThan(0);
      }
      droppedByArm[arm.id] = dropped;
    }
    for (const arm of CHUNK_SIZE_ARMS) {
      expect(droppedByArm[arm.id], `${arm.id} dropped answer spans`).toEqual([]);
    }
  });

  /**
   * #1178's acceptance criterion, asserted on the real corpus rather than on a
   * fixture: a substantive source line must appear, whole, in some chunk.
   *
   * **It is met at the shipped 2048/256 and at 3072, and NOT fully at the two
   * small arms** — 3 lines at 1024 and 6 at 768 survive, so the pin is a
   * ceiling rather than a zero. Those are not content gaps. The union of the chunks
   * covers 99.8% of the corpus's characters at every arm (the remainder is inter-chunk
   * whitespace that `trim()` drops by design), so the text IS indexed; what fails is
   * the stricter substring property, because a boundary splits one very long line and
   * neither side holds it whole.
   *
   * Every survivor is 410–886 characters, and two of
   * them are LONGER THAN THE 768-CHARACTER CHUNK — no chunk of that arm can contain
   * them, at any boundary policy. The shortest, a 410-character `SECURITY.md` line,
   * is not self-evidently pathological on length alone: it survives because it begins
   * 362 characters into its 768-character window, 22 below the
   * `ceil(768 × 0.5) = 384` floor. Driving the rest to zero would mean letting
   * `findBoundary` accept a line end below {@link MIN_BOUNDARY_FRACTION}, which is
   * precisely the near-zero-advance pathology the floor exists to prevent; trading a
   * guaranteed advance for seven pathological lines is the wrong side of that deal.
   *
   * **#1184 moved these ceilings by one line each, and the cause is the ARM change, not
   * a chunker regression.** The size arms used to hold overlap at a constant ratio
   * (1024/128, 768/96) and now request the control's absolute 256 (`SIZE_ARM_OVERLAP`,
   * clamped to 192 at 768), because #1183 measured overlap to be a null at 2048 and a
   * second moving part per arm buys nothing. Measured on this corpus, the ratio arms give
   * 2 and 5 and the constant-overlap arms give 3 and 6 — a *larger* carry-over dropping
   * one MORE line, which reads backwards until you notice the survivors are decided by
   * where the boundary lands rather than by how much is carried over: a longer overlap
   * resumes the window earlier and re-positions every subsequent cut. Every survivor at
   * both settings is 410–921 characters, i.e. the same long-line class, so nothing new
   * is being lost.
   *
   * The ceilings are exact, not slack, so a regression that drops one more line
   * fails here.
   */
  it("leaves no substantive source line out of every chunk at the shipped arm", async () => {
    const corpus = await loadDocRetrievalCorpus();
    // Lines this long are excluded from the "substantive" count by #1178's convention.
    const SUBSTANTIVE_MIN_CHARS = 12;
    const ceilings: Record<string, number> = {
      "size-3072": 0,
      "size-2048": 0,
      "size-1024": 3,
      "size-768": 6,
    };
    for (const arm of CHUNK_SIZE_ARMS) {
      let dropped = 0;
      for (const doc of corpus.docs) {
        const haystack = chunkMarkdown(doc.text, {
          chunkSize: arm.chunkSize,
          overlap: arm.overlap,
        })
          .map((c) => c.text)
          .join("\n\n");
        for (const raw of doc.text.split("\n")) {
          const trimmed = raw.trim();
          // Heading markers are re-emitted at heading DEPTH, not source level, so
          // compare the heading TEXT — see `chunk-alignment.ts`'s header.
          const heading = /^#{1,6}\s+(.*?)\s*$/.exec(trimmed);
          const line = heading ? heading[1] : trimmed;
          if (line.length > SUBSTANTIVE_MIN_CHARS && !haystack.includes(line)) dropped += 1;
        }
      }
      expect(dropped, `${arm.id} substantive lines absent from every chunk`).toBe(ceilings[arm.id]);
    }
  });
});

describe("loadDocRetrievalCorpus validation", () => {
  it("rejects a corpus directory that does not exist, naming the id", async () => {
    await expect(loadDocRetrievalCorpus("docretrieval-does-not-exist")).rejects.toThrow();
  });
});

/**
 * #1157's lesson, applied to this corpus: a frozen corpus must be checked against
 * the commit it DECLARES, never against HEAD — the live `docs/` tree moves, and a
 * test that fails when it does invites a resync that silently re-bases the corpus
 * mid-epic and destroys the before/after comparison it exists to provide.
 *
 * The manifest's hashes were read from `git show <snapshotCommit>:<source>` at
 * generation time, so hashing the committed snapshot against them needs no git,
 * behaves identically on CI's depth-1 clone, and fails only on drift IN THE
 * SNAPSHOT. Without this, the manifest is an inert file rather than a guard.
 */
describe.each([DEFAULT_DOC_CORPUS_ID, WIDE_DOC_CORPUS_ID])("the %s snapshot manifest", (id) => {
  it("covers every snapshotted document and nothing else", async () => {
    const { loadSnapshotManifest } = await import("../embed-retrieval/corpus.js");
    const manifest = await loadSnapshotManifest(docCorpusDir(id));
    const corpus = await loadDocRetrievalCorpus(id);
    expect(manifest.corpusId).toBe(id);
    expect(manifest.algorithm).toBe("sha256");
    expect(Object.keys(manifest.files).sort()).toEqual(
      corpus.docs.map((d) => `${DOC_SNAPSHOT_DIR}/${d.id}`).sort(),
    );
  });

  it("matches the committed snapshot bytes, so drift in the corpus fails loudly", async () => {
    const { createHash } = await import("node:crypto");
    const { promises: fs } = await import("node:fs");
    const path = (await import("node:path")).default;
    const { loadSnapshotManifest } = await import("../embed-retrieval/corpus.js");
    const dir = docCorpusDir(id);
    const manifest = await loadSnapshotManifest(dir);
    for (const [rel, entry] of Object.entries(manifest.files)) {
      const bytes = await fs.readFile(path.join(dir, rel));
      expect(createHash("sha256").update(bytes).digest("hex"), rel).toBe(entry.sha256);
    }
  });

  it("claims a real repo-relative provenance path for every document", async () => {
    const { loadSnapshotManifest } = await import("../embed-retrieval/corpus.js");
    const manifest = await loadSnapshotManifest(docCorpusDir(id));
    for (const [rel, entry] of Object.entries(manifest.files)) {
      // `docs/OPERATIONS.md` in the snapshot came from `docs/OPERATIONS.md` in the repo.
      expect(entry.source, rel).toBe(rel);
    }
  });
});

describe("longestSharedWordRun", () => {
  it("counts CONSECUTIVE shared words, not shared vocabulary", () => {
    expect(longestSharedWordRun("alpha beta gamma delta", "zzz alpha beta gamma yyy")).toBe(3);
  });

  it("scores a question sharing only scattered topic words as barely copied", () => {
    // Every word of the question appears in the span, but never two in a row: bag-of-words
    // overlap reads 1.00 here and the run reads 1. That gap is the whole point.
    expect(longestSharedWordRun("alpha gamma", "alpha zzz gamma")).toBe(1);
  });

  it("is 0 when nothing is shared, and 0 against an empty side", () => {
    expect(longestSharedWordRun("alpha beta", "gamma delta")).toBe(0);
    expect(longestSharedWordRun("", "gamma delta")).toBe(0);
    expect(longestSharedWordRun("alpha beta", "")).toBe(0);
  });

  it("sees through punctuation and markdown emphasis, so re-punctuating does not hide a copy", () => {
    expect(
      longestSharedWordRun(
        "is it re-sent with every new prompt?",
        "**is re-sent with every new prompt** you type",
      ),
    ).toBe(6);
  });

  it("splits on non-word characters but keeps underscores, so `pr_review.dlq` is two words", () => {
    expect(corpusWords("A spike in `pr_review.dlq` rows")).toEqual([
      "a",
      "spike",
      "in",
      "pr_review",
      "dlq",
      "rows",
    ]);
  });
});

describe("idfWeightedQuestionCoverage", () => {
  const docs = [
    { id: "a.md", text: "alpha common common ubiquitous" },
    { id: "b.md", text: "beta common ubiquitous" },
    { id: "c.md", text: "gamma ubiquitous" },
    { id: "d.md", text: "delta ubiquitous" },
  ];
  const idf = buildCorpusIdf(docs);

  it("weights a rare word above a ubiquitous one", () => {
    expect(idf("alpha")).toBeGreaterThan(idf("common"));
    expect(idf("common")).toBeGreaterThan(idf("ubiquitous"));
  });

  it("gives an unseen word the maximal df = 0 weight rather than throwing", () => {
    expect(idf("neverseen")).toBeGreaterThan(idf("alpha"));
    expect(Number.isFinite(idf("neverseen"))).toBe(true);
  });

  it("is 1.00 when the span contains every question term, and 0.00 when it shares none", () => {
    expect(idfWeightedQuestionCoverage("alpha common", "alpha and common", idf)).toBeCloseTo(1, 10);
    expect(idfWeightedQuestionCoverage("alpha common", "gamma delta", idf)).toBe(0);
  });

  it("is 0 for a question with no words, rather than dividing by zero", () => {
    expect(idfWeightedQuestionCoverage("", "alpha", idf)).toBe(0);
    expect(idfWeightedQuestionCoverage("!!! ---", "alpha", idf)).toBe(0);
  });

  /**
   * The property that makes this worth having beside {@link longestSharedWordRun}: the run
   * is order-SENSITIVE and BM25 is not. A question that donates its span's rare terms
   * scattered scores a run of 1 and a coverage near 1.
   */
  it("scores scattered rare-term donation high where the contiguous run scores 1", () => {
    const question = "alpha gamma";
    const span = "alpha ubiquitous gamma";
    expect(longestSharedWordRun(question, span)).toBe(1);
    expect(idfWeightedQuestionCoverage(question, span, idf)).toBeCloseTo(1, 10);
  });

  it("deduplicates question terms, so repeating a word does not double its weight", () => {
    const once = idfWeightedQuestionCoverage("alpha ubiquitous", "alpha", idf);
    const twice = idfWeightedQuestionCoverage("alpha alpha ubiquitous", "alpha", idf);
    expect(twice).toBe(once);
  });
});

/**
 * #1184's wide corpus, and the two disciplines that decide whether it is valid at all.
 *
 * The exact-once check is MECHANICAL and runs over every query, not a sample:
 * {@link loadDocRetrievalCorpus} calls {@link resolveSpan} per query, which throws on
 * zero occurrences and on more than one. A corpus that loads has already proved the
 * property for all 168 — the tests below pin the count and the copy-discipline that
 * loading cannot check.
 */
describe("the wide corpus (#1184)", () => {
  /**
   * This test used to assert the corpus CLEARED the bar, and at 198 queries it did. Pruning
   * for publication took it to 168, below the binding arm's requirement, and the honest
   * response is to assert the shortfall rather than lower a bar computed from measured
   * intervals. It goes red the moment the corpus is regrown past the requirement — at
   * which point restore the original `toBeGreaterThanOrEqual`.
   */
  it("falls SHORT of the pre-registered floor on the binding size arm since publication", async () => {
    const { PRIOR_RUN_SIZING, sizeArm, corpusGoNoGo } = await import("./power-sizing.js");
    const corpus = await loadDocRetrievalCorpus(WIDE_DOC_CORPUS_ID);
    // The bar is COMPUTED from #1183's committed intervals, never written here: the
    // binding arm's requirement at the +0.04 floor is what the corpus had to clear.
    const decision = corpusGoNoGo(PRIOR_RUN_SIZING.map((i) => sizeArm(i)));
    expect(decision.queriesNeeded).not.toBeNull();
    expect(decision.go).toBe(true);
    expect(corpus.queries.length).toBeLessThan(decision.queriesNeeded ?? 0);
    // And still inside the ceiling pre-registered before any corpus work began.
    expect(corpus.queries.length).toBeLessThanOrEqual(decision.ceiling);
  });

  it("every quote resolves to exactly one span — checked over all queries, not sampled", async () => {
    const corpus = await loadDocRetrievalCorpus(WIDE_DOC_CORPUS_ID);
    const byDoc = new Map(corpus.docs.map((d) => [d.id, d.text]));
    for (const q of corpus.queries) {
      const text = byDoc.get(q.doc) ?? "";
      expect(text.indexOf(q.quote), q.id).toBe(q.spanStart);
      expect(text.indexOf(q.quote, q.spanStart + 1), q.id).toBe(-1);
      expect(q.quote.length).toBeGreaterThanOrEqual(MIN_SPAN_CHARS);
      expect(q.quote.length).toBeLessThanOrEqual(MAX_SPAN_CHARS);
    }
  });

  /**
   * Only `id` uniqueness is enforced at load ({@link resolveQueries}); `question` and
   * `quote` were audited by hand and were clean, which is exactly the state that regresses
   * silently. Two queries sharing a question, or anchoring on the same span of the same
   * document, would both load without complaint and double-weight one piece of ground
   * truth — inflating n without adding information, and pulling every arm toward whichever
   * fact got counted twice.
   *
   * Guarded at the `(doc, quote)` grain rather than on `quote` alone: two different
   * documents may legitimately contain the same sentence, and there the ground truth is
   * genuinely different.
   */
  it("repeats no question and no span, which loading does not check", async () => {
    const corpus = await loadDocRetrievalCorpus(WIDE_DOC_CORPUS_ID);
    const n = corpus.queries.length;
    expect(new Set(corpus.queries.map((q) => q.id)).size).toBe(n);
    expect(new Set(corpus.queries.map((q) => q.question)).size).toBe(n);
    expect(new Set(corpus.queries.map((q) => `${q.doc} ${q.quote}`)).size).toBe(n);
  });

  /**
   * A ceiling, not a pin of the current maximum: the committed corpus's worst query
   * shares an eight-word run (`dq-dbi-03`, "carved out of the consuming agent's budget"),
   * which is a domain noun phrase inside a question the span does not answer verbatim.
   * Anything materially longer is a restated sentence rather than a shared subject, and
   * that is the #1159 failure this bounds.
   *
   * The MAXIMUM alone is not enough, and that gap is the review finding this second
   * assertion closes: a future batch in which sixty queries each shared a seven-word run
   * would leave the ceiling untouched while turning the corpus into the keyword register
   * #1157 warns against. So the MASS is bounded too. Both numbers are exact on the
   * committed corpus (worst 8; fifteen queries at ≥ 5, against 89 at ≤ 1), so neither is
   * slack — a new batch that pushes either has to justify itself here.
   */
  it("contains no query that restates its answer span, and few that come close", async () => {
    const corpus = await loadDocRetrievalCorpus(WIDE_DOC_CORPUS_ID);
    const runs = corpus.queries
      .map((q) => ({ id: q.id, run: longestSharedWordRun(q.question, q.quote) }))
      .sort((a, b) => b.run - a.run);
    expect(runs[0].run, `${runs[0].id} shares too long a run with its span`).toBeLessThanOrEqual(8);
    const nearMisses = runs.filter((r) => r.run >= 5);
    expect(
      nearMisses.length,
      `too many queries share a long run: ${nearMisses.map((r) => `${r.id}=${r.run}`).join(", ")}`,
    ).toBeLessThanOrEqual(15);
  });

  /**
   * The SECOND dimension of copy discipline, and the review finding that produced it: the
   * contiguous run is order-sensitive and BM25 is not, so scattered rare-term donation
   * scores a short run while still handing the lexical channel the answer.
   *
   * This is a ceiling on the other tail, plus a live assertion that the two instruments
   * genuinely disagree — if no high-coverage query ever had a short run, the second
   * dimension would be redundant and this test should be deleted rather than kept green
   * by accident. Both bounds are exact today: fourteen queries clear 0.60, five of them
   * with a run ≤ 2 (seventeen cleared it before seven documents were removed for
   * publication).
   */
  it("bounds scattered rare-term donation, the tail a contiguous run cannot see", async () => {
    const corpus = await loadDocRetrievalCorpus(WIDE_DOC_CORPUS_ID);
    const idf = buildCorpusIdf(corpus.docs);
    const rows = corpus.queries.map((q) => ({
      id: q.id,
      run: longestSharedWordRun(q.question, q.quote),
      coverage: idfWeightedQuestionCoverage(q.question, q.quote, idf),
    }));
    const donors = rows.filter((r) => r.coverage >= 0.6);
    expect(
      donors.length,
      `too many queries donate their span's rare terms: ${donors
        .map((r) => `${r.id}=${r.coverage.toFixed(3)}`)
        .join(", ")}`,
    ).toBeLessThanOrEqual(14);
    // The run is blind to part of that tail, which is the fact that motivates reporting
    // both. Exact today, so this goes red if the overlap between the instruments changes
    // in EITHER direction — including toward the second dimension being redundant.
    expect(donors.filter((r) => r.run <= 2).length).toBe(5);
  });

  /**
   * The worked example in {@link longestSharedWordRun}'s docstring, DERIVED here so it
   * cannot rot into prose no committed file backs — the defect class this epic has now
   * had to retract twice (the "~98% overlap" and "540–886" figures, and the `f04`
   * justification this assertion replaced).
   *
   * `dq-tms-02` and `dq-lsv-02` share the same three-word run, so the primary instrument
   * cannot separate them. Raw bag-of-words coverage ranks `dq-tms-02` higher; IDF weighting
   * inverts that outright, because raw coverage was reading `dq-tms-02`'s function words.
   * (The example was `f13` until its document was removed before publication; the
   * inversion was re-derived, not assumed, on the pruned corpus.) That inversion
   * is the argument for weighting, and it is checked rather than recalled.
   */
  it("derives the docstring's bag-of-words-versus-IDF inversion from the corpus itself", async () => {
    const corpus = await loadDocRetrievalCorpus(WIDE_DOC_CORPUS_ID);
    const idf = buildCorpusIdf(corpus.docs);
    const byId = new Map(corpus.queries.map((q) => [q.id, q]));
    const bagCoverage = (question: string, quote: string): number => {
      const terms = new Set(corpusWords(question));
      const span = new Set(corpusWords(quote));
      if (terms.size === 0) return 0;
      return [...terms].filter((t) => span.has(t)).length / terms.size;
    };
    const measure = (id: string) => {
      const q = byId.get(id);
      expect(q, `${id} is no longer in the corpus`).toBeDefined();
      if (!q) throw new Error(`${id} missing`);
      return {
        run: longestSharedWordRun(q.question, q.quote),
        bag: bagCoverage(q.question, q.quote),
        idf: idfWeightedQuestionCoverage(q.question, q.quote, idf),
      };
    };
    const tms = measure("dq-tms-02");
    const lsv = measure("dq-lsv-02");

    // Same contiguous run: the primary instrument reports them as equally clean.
    expect(tms.run).toBe(3);
    expect(lsv.run).toBe(3);
    // Raw coverage ranks dq-tms-02 the more copied of the two...
    expect(tms.bag).toBeGreaterThan(lsv.bag);
    // ...and IDF weighting reverses it, with dq-lsv-02 the corpus maximum.
    expect(lsv.idf).toBeGreaterThan(tms.idf);
    const maxCoverage = Math.max(
      ...corpus.queries.map((q) => idfWeightedQuestionCoverage(q.question, q.quote, idf)),
    );
    expect(lsv.idf).toBe(maxCoverage);

    // And the other half of the docstring's claim: raw coverage never attains 1.00 here,
    // because a question always carries words its span does not.
    const maxBag = Math.max(...corpus.queries.map((q) => bagCoverage(q.question, q.quote)));
    expect(maxBag).toBeLessThan(1);
    expect(maxBag).toBeLessThanOrEqual(0.765);
  });

  /**
   * The residual the common-mode argument in {@link idfWeightedQuestionCoverage} cannot
   * discharge is that rare-term donation might interact with chunk size rather than merely
   * offset it. What bounds it is that the donation is concentrated in the stratum the
   * corpus already DECLARES and reports, so it is visible to a reader of the artefact
   * rather than hidden inside `all`.
   *
   * That is a property of the corpus, not a law, so it is asserted: if a future batch put
   * the flattery in the `paraphrase` stratum instead, the residual would stop being
   * bounded by anything published and this should go red.
   */
  it("concentrates rare-term donation in the stratum it declares, not in `paraphrase`", async () => {
    const corpus = await loadDocRetrievalCorpus(WIDE_DOC_CORPUS_ID);
    const idf = buildCorpusIdf(corpus.docs);
    const rows = corpus.queries.map((q) => ({
      phrasing: q.phrasing,
      coverage: idfWeightedQuestionCoverage(q.question, q.quote, idf),
    }));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const lexical = rows.filter((r) => r.phrasing === "lexical");
    const paraphrase = rows.filter((r) => r.phrasing === "paraphrase");
    // The two figures the docstrings and ARCHITECTURE.md quote, pinned to three decimals
    // so neither can become a number no committed file backs.
    expect(mean(lexical.map((r) => r.coverage))).toBeCloseTo(0.349, 3);
    expect(mean(paraphrase.map((r) => r.coverage))).toBeCloseTo(0.171, 3);
    // Above 0.60 the declared stratum is over-represented against its own base rate.
    const donors = rows.filter((r) => r.coverage >= 0.6);
    expect(donors.filter((r) => r.phrasing === "lexical").length).toBe(11);
    expect(lexical.length).toBe(83);
    expect(donors.filter((r) => r.phrasing === "lexical").length / donors.length).toBeGreaterThan(
      lexical.length / rows.length,
    );
  });

  /**
   * The property that makes #1183's and #1178's committed artefacts still readable: the
   * wide corpus EXTENDS the original rather than re-basing it. Same snapshot commit, the
   * nine original documents byte-identical, and all forty-three original queries carried
   * over unchanged — so a delta measured here and a delta measured there differ by the
   * corpus's SIZE and by nothing else.
   */
  it("is a strict superset of the original corpus, at the same snapshot commit", async () => {
    const original = await loadDocRetrievalCorpus(DEFAULT_DOC_CORPUS_ID);
    const wide = await loadDocRetrievalCorpus(WIDE_DOC_CORPUS_ID);
    expect(wide.snapshotCommit).toBe(original.snapshotCommit);

    const wideDocs = new Map(wide.docs.map((d) => [d.id, d.text]));
    for (const doc of original.docs) expect(wideDocs.get(doc.id), doc.id).toBe(doc.text);
    expect(wide.docs.length).toBeGreaterThan(original.docs.length);

    const wideQueries = new Map(wide.queries.map((q) => [q.id, q]));
    for (const q of original.queries) {
      const carried = wideQueries.get(q.id);
      expect(carried, q.id).toBeDefined();
      expect(carried?.question, q.id).toBe(q.question);
      expect(carried?.quote, q.id).toBe(q.quote);
      expect(carried?.doc, q.id).toBe(q.doc);
    }
    expect(wide.queries.length).toBeGreaterThan(original.queries.length);
  });

  it("spreads queries over every snapshotted document and carries both phrasing strata", async () => {
    const corpus = await loadDocRetrievalCorpus(WIDE_DOC_CORPUS_ID);
    expect(new Set(corpus.queries.map((q) => q.doc)).size).toBe(corpus.docs.length);
    const counts = { lexical: 0, paraphrase: 0 };
    for (const q of corpus.queries) counts[q.phrasing] += 1;
    expect(counts.lexical).toBeGreaterThan(0);
    expect(counts.paraphrase).toBeGreaterThan(0);
  });

  it("uses LF line endings, which the offset alignment assumes", async () => {
    const corpus = await loadDocRetrievalCorpus(WIDE_DOC_CORPUS_ID);
    for (const doc of corpus.docs) expect(doc.text).not.toContain("\r");
  });

  /**
   * Every answer span survives chunking at every arm — the property that makes a delta
   * measured here attributable to RANKING rather than to differential content loss
   * (#1178). This is the corpus the #1184 decision rests on, so it needs its own
   * regression detector; the original corpus's is above.
   */
  it("drops no answer span at any arm, so the arms index the same content", async () => {
    const corpus = await loadDocRetrievalCorpus(WIDE_DOC_CORPUS_ID);
    const byDoc = new Map(corpus.docs.map((d) => [d.id, d.text]));
    for (const arm of CHUNK_SIZE_ARMS) {
      const dropped: string[] = [];
      for (const q of corpus.queries) {
        const text = byDoc.get(q.doc) ?? "";
        const aligned = alignChunksToSource(
          text,
          chunkMarkdown(text, { chunkSize: arm.chunkSize, overlap: arm.overlap }),
        );
        if (bestCoveringChunk(aligned, q.spanStart, q.spanEnd) === null) dropped.push(q.id);
      }
      expect(dropped, `${arm.id} dropped answer spans`).toEqual([]);
    }
  });

  /**
   * The wide corpus's own substantive-line ceilings. Higher than the original's in
   * absolute terms because it holds 1.8× the characters; every survivor is again a
   * single line of 410–921 characters that no boundary policy can hold whole at the
   * small arms. See the original corpus's version of this test for the mechanism and
   * for why driving it to zero is the wrong trade.
   */
  it("leaves only the known long lines out of every chunk", async () => {
    const corpus = await loadDocRetrievalCorpus(WIDE_DOC_CORPUS_ID);
    const SUBSTANTIVE_MIN_CHARS = 12;
    const ceilings: Record<string, number> = {
      "size-3072": 0,
      "size-2048": 0,
      "size-1024": 4,
      "size-768": 12,
    };
    for (const arm of CHUNK_SIZE_ARMS) {
      let dropped = 0;
      for (const doc of corpus.docs) {
        const haystack = chunkMarkdown(doc.text, {
          chunkSize: arm.chunkSize,
          overlap: arm.overlap,
        })
          .map((c) => c.text)
          .join("\n\n");
        for (const raw of doc.text.split("\n")) {
          const trimmed = raw.trim();
          const heading = /^#{1,6}\s+(.*?)\s*$/.exec(trimmed);
          const line = heading ? heading[1] : trimmed;
          if (line.length > SUBSTANTIVE_MIN_CHARS && !haystack.includes(line)) dropped += 1;
        }
      }
      expect(dropped, `${arm.id} substantive lines absent from every chunk`).toBe(ceilings[arm.id]);
    }
  });
});
