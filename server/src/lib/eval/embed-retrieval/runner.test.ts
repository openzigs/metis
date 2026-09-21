/**
 * Runner tests — and, more importantly, the PROOF THAT THE EVAL CAN FAIL.
 *
 * A gate that cannot fail is theatre. These tests drive the real runner with
 * synthetic embedders whose quality is known by construction (an oracle, a
 * degraded/partially-scrambled embedder, and pure noise) and assert that the
 * eval RANKS THEM CORRECTLY and that the verdict flips to NO-GO / INVALID when
 * it should. No weights, no network — these run in CI.
 */
import { describe, expect, it } from "vitest";
import type { EmbedRetrievalCorpus } from "./corpus.js";
import { aggregate } from "./metrics.js";
import { createMemoryVectorStore, embedBatched, runArm, runLexicalBaseline } from "./runner.js";
import { computeVerdict } from "./verdict.js";

// ---------------------------------------------------------------------------
// A tiny synthetic corpus: 6 topics, one target doc per topic + 6 distractors.
// ---------------------------------------------------------------------------
const TOPICS = ["budget", "leader", "vault", "saml", "throttle", "replica"] as const;
type Topic = (typeof TOPICS)[number];

function makeCorpus(): EmbedRetrievalCorpus {
  const docs = [
    ...TOPICS.map((t, i) => ({
      id: `target-${t}`,
      filePath: `${t}.ts`,
      name: `${t}Handler`,
      kind: "function",
      text: `function ${t}Handler in ${t}.ts`,
      topic: t,
      order: i,
    })),
    ...TOPICS.map((t, i) => ({
      id: `distractor-${i}`,
      filePath: `misc-${i}.ts`,
      name: `helper${i}`,
      kind: "function",
      text: `function helper${i} in misc-${i}.ts`,
      topic: null,
      order: i,
    })),
  ];

  return {
    spec: {
      id: "synthetic",
      title: "synthetic",
      snapshotCommit: "test",
      groundTruth: "synthetic",
      queries: [],
    },
    projectId: "p1",
    symbols: [],
    docs: docs.map((d) => ({
      id: d.id,
      filePath: d.filePath,
      name: d.name,
      kind: d.kind,
      text: d.text,
    })),
    searchable: docs.map((d) => ({
      symbolId: d.id,
      name: d.name,
      qualifiedName: d.name,
      kind: d.kind,
      filePath: d.filePath,
    })),
    queries: TOPICS.map((t) => ({
      id: `Q-${t}`,
      requirement: `the system must handle ${t}`,
      relevant: [`target-${t}`],
      strata: null,
    })),
  };
}

/** Which topic a text belongs to (both docs and queries mention the topic word). */
function topicOf(text: string): Topic | null {
  return TOPICS.find((t) => text.includes(t)) ?? null;
}

function oneHot(index: number, dim = TOPICS.length + 1): number[] {
  return Array.from({ length: dim }, (_, i) => (i === index ? 1 : 0));
}

/** Perfect semantic embedder: same topic ⇒ identical vector. */
async function oracleEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((t) => {
    const topic = topicOf(t);
    return topic ? oneHot(TOPICS.indexOf(topic)) : oneHot(TOPICS.length);
  });
}

/** Chance-level embedder: deterministic hash of the text, semantically meaningless. */
async function noiseEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((t) => {
    const dim = TOPICS.length + 1;
    let h = 2166136261;
    for (let i = 0; i < t.length; i += 1) {
      h = Math.imul(h ^ t.charCodeAt(i), 16777619);
    }
    return Array.from({ length: dim }, (_, i) => {
      const x = Math.sin(h * (i + 1)) * 10000;
      return x - Math.floor(x) - 0.5;
    });
  });
}

/**
 * A DEGRADED embedder — the shape of a wrong-pooled model: it keeps the semantic
 * signal for SOME inputs and loses it for others, so its vectors remain finite,
 * plausible and same-dimensioned while retrieval is measurably worse. Half the
 * topics retain their semantics; half collapse to noise.
 */
async function degradedEmbed(texts: string[]): Promise<number[][]> {
  const noise = await noiseEmbed(texts);
  const oracle = await oracleEmbed(texts);
  return texts.map((text, i) => {
    const topic = topicOf(text);
    const retained = topic !== null && TOPICS.indexOf(topic) % 2 === 0;
    return retained ? oracle[i] : noise[i];
  });
}

describe("runArm", () => {
  it("scores all three channels and reports corpus shape", async () => {
    const corpus = makeCorpus();
    const result = await runArm("oracle", corpus, oracleEmbed);
    expect(result.armId).toBe("oracle");
    expect(result.docCount).toBe(12);
    expect(result.queryCount).toBe(6);
    expect(result.channels.vector.queryCount).toBe(6);
    expect(result.channels.hybrid.queryCount).toBe(6);
    expect(result.channels.bm25.queryCount).toBe(6);
    expect(result.vectorQueries).toHaveLength(6);
  });

  it("gives an oracle embedder a perfect vector channel", async () => {
    const result = await runArm("oracle", makeCorpus(), oracleEmbed);
    expect(result.channels.vector.ndcgAtK[10]).toBeCloseTo(1);
    expect(result.channels.vector.recallAtK[1]).toBeCloseTo(1);
    expect(result.channels.vector.mrr).toBeCloseTo(1);
  });

  it("THE EVAL CAN FAIL — a noise embedder scores far worse than an oracle", async () => {
    const oracle = await runArm("oracle", makeCorpus(), oracleEmbed);
    const noise = await runArm("noise", makeCorpus(), noiseEmbed);
    expect(noise.channels.vector.ndcgAtK[10]).toBeLessThan(
      oracle.channels.vector.ndcgAtK[10] - 0.3,
    );
  });

  it("detects a DEGRADED (wrong-pooling-shaped) embedder, not just a broken one", async () => {
    const oracle = await runArm("oracle", makeCorpus(), oracleEmbed);
    const degraded = await runArm("degraded", makeCorpus(), degradedEmbed);
    // Plausible vectors, still measurably worse — the exact failure mode #782 warned about.
    expect(degraded.channels.vector.ndcgAtK[10]).toBeLessThan(oracle.channels.vector.ndcgAtK[10]);
  });

  it("hybrid can mask a broken vector channel — which is why vector is measured alone", async () => {
    const noise = await runArm("noise", makeCorpus(), noiseEmbed);
    // BM25 still finds the topic word, so the fused ranking looks healthier than
    // the vector channel that feeds it.
    expect(noise.channels.hybrid.ndcgAtK[10]).toBeGreaterThan(noise.channels.vector.ndcgAtK[10]);
  });
});

// ---------------------------------------------------------------------------
// The BM25 reference line must not depend on the embedder.
//
// The ORIGINAL test for this property was a false positive. It compared the bm25
// channel of an oracle arm and a noise arm on the 12-doc corpus above, where every
// query has exactly ONE relevant doc and BM25 always ranks it #1. Vector-derived
// docs did leak into the "BM25-only" top-10 (`HybridCodeSearch` inserted every
// vector hit into the fused map even at `vectorWeight: 0`), but they landed at
// ranks 2-10 among irrelevant docs — so no aggregate metric moved, and the test
// passed while the property it claimed to check was false. On the real 183-symbol
// corpus the same leak moved the bm25 line by 0.060 nDCG@10 across arms.
//
// This corpus is built so the leak is VISIBLE in the metrics:
//
//   - every query has TWO relevant docs: `target-<t>`, whose symbol NAME contains
//     the topic word (so BM25 finds it), and `alt-<t>`, whose symbol name shares
//     NO token with the query (so BM25 can never find it) but whose embedding text
//     is on-topic (so the vector channel can).
//   - `alt-<t>` is therefore reachable ONLY through the vector channel. If a
//     vector hit can reach the bm25 ranking, recall@10 there goes 0.5 → 1.0.
//
// Two embedders differ ONLY in where they rank the alt docs: `altFirstEmbed` puts
// them at the top (cosine +1), `altLastEmbed` at the very bottom (cosine −1). A
// genuinely lexical channel cannot tell them apart. The leaking one scored
// recall@10 = 1.0 for the first and 0.5 for the second — so this test FAILS
// against the old behaviour by construction, not by luck.
// ---------------------------------------------------------------------------
const ALT_MARKER = "companion-impl";

function makeAltCorpus(): EmbedRetrievalCorpus {
  const docs = [
    ...TOPICS.map((t) => ({
      id: `target-${t}`,
      filePath: `${t}.ts`,
      // Symbol name carries the topic word ⇒ BM25 CAN find this one.
      name: `${t}Handler`,
      kind: "function",
      text: `function ${t}Handler in ${t}.ts`,
    })),
    ...TOPICS.map((t, i) => ({
      id: `alt-${t}`,
      filePath: `companion-${i}.ts`,
      // Symbol name shares NO token with any query ⇒ BM25 can NEVER find this one.
      name: `companionZeta${i}`,
      kind: "function",
      // ...but the embedded text is on-topic ⇒ the VECTOR channel can.
      text: `${ALT_MARKER} covering ${t} in companion-${i}.ts`,
    })),
    ...TOPICS.map((t, i) => ({
      id: `distractor-${i}`,
      filePath: `misc-${i}.ts`,
      name: `helper${i}`,
      kind: "function",
      text: `function helper${i} in misc-${i}.ts`,
    })),
  ];

  return {
    spec: {
      id: "synthetic-alt",
      title: "synthetic-alt",
      snapshotCommit: "test",
      groundTruth: "synthetic",
      queries: [],
    },
    projectId: "p1",
    symbols: [],
    docs: docs.map((d) => ({
      id: d.id,
      filePath: d.filePath,
      name: d.name,
      kind: d.kind,
      text: d.text,
    })),
    searchable: docs.map((d) => ({
      symbolId: d.id,
      name: d.name,
      qualifiedName: d.name,
      kind: d.kind,
      filePath: d.filePath,
    })),
    queries: TOPICS.map((t) => ({
      id: `Q-${t}`,
      requirement: `the system must handle ${t}`,
      // BOTH implementations are relevant; only one is lexically reachable.
      relevant: [`target-${t}`, `alt-${t}`],
      strata: null,
    })),
  };
}

/** Alt docs rank FIRST in the vector channel (cosine +1 with their topic query). */
async function altFirstEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((t) => {
    const topic = topicOf(t);
    return topic ? oneHot(TOPICS.indexOf(topic)) : oneHot(TOPICS.length);
  });
}

/** Alt docs rank LAST in the vector channel (cosine −1). Otherwise identical. */
async function altLastEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((t) => {
    const topic = topicOf(t);
    if (!topic) return oneHot(TOPICS.length);
    const v = oneHot(TOPICS.indexOf(topic));
    return t.includes(ALT_MARKER) ? v.map((x) => -x) : v;
  });
}

describe("the BM25 reference line does not depend on the embedder", () => {
  it("is IDENTICAL across two arms whose vector rankings are opposites", async () => {
    const corpus = makeAltCorpus();
    const altFirst = await runArm("alt-first", corpus, altFirstEmbed);
    const altLast = await runArm("alt-last", corpus, altLastEmbed);

    // Guard against a VACUOUS pass: the two embedders must genuinely produce
    // different rankings, or "identical bm25" would prove nothing.
    expect(altFirst.channels.vector.recallAtK[10]).toBeCloseTo(1.0);
    expect(altLast.channels.vector.recallAtK[10]).toBeCloseTo(0.5);

    // The channel under test cannot see that difference.
    expect(altLast.channels.bm25).toEqual(altFirst.channels.bm25);
  });

  it("contains ONLY lexically-matched docs — a vector-only doc never appears in it", async () => {
    const corpus = makeAltCorpus();
    const altFirst = await runArm("alt-first", corpus, altFirstEmbed);

    // `alt-<t>` is relevant and sits at vector rank 1, but shares no token with the
    // query, so a true BM25 channel retrieves exactly ONE of the two relevant docs.
    // The old leaking implementation scored 1.0 here.
    expect(altFirst.channels.bm25.recallAtK[10]).toBeCloseTo(0.5);
  });
});

describe("end-to-end verdict on synthetic arms", () => {
  it("returns GO when the candidate genuinely beats the incumbent and the traps behave", async () => {
    const corpus = makeCorpus();
    const verdict = computeVerdict({
      incumbent: await runArm("incumbent", corpus, degradedEmbed),
      candidate: await runArm("candidate", corpus, oracleEmbed),
      "wrong-pooling": await runArm("wrong", corpus, degradedEmbed),
      "hash-floor": await runArm("hash", corpus, noiseEmbed),
    });
    expect(verdict.outcome).toBe("GO");
  });

  it("returns NO-GO when the candidate is no better than the incumbent", async () => {
    const corpus = makeCorpus();
    const verdict = computeVerdict({
      incumbent: await runArm("incumbent", corpus, oracleEmbed),
      candidate: await runArm("candidate", corpus, oracleEmbed),
      "wrong-pooling": await runArm("wrong", corpus, degradedEmbed),
      "hash-floor": await runArm("hash", corpus, noiseEmbed),
    });
    expect(verdict.outcome).toBe("NO-GO");
  });

  it("returns INVALID when the wrong-pooling arm is NOT worse than the candidate", async () => {
    const corpus = makeCorpus();
    const verdict = computeVerdict({
      incumbent: await runArm("incumbent", corpus, noiseEmbed),
      candidate: await runArm("candidate", corpus, oracleEmbed),
      // Same embedder as the candidate ⇒ the eval cannot see pooling ⇒ INVALID.
      "wrong-pooling": await runArm("wrong", corpus, oracleEmbed),
      "hash-floor": await runArm("hash", corpus, noiseEmbed),
    });
    expect(verdict.outcome).toBe("INVALID");
    expect(verdict.checks.find((c) => c.id === "detects-wrong-pooling")?.passed).toBe(false);
  });

  it("returns INVALID when the eval cannot separate a real embedder from noise", async () => {
    const corpus = makeCorpus();
    const verdict = computeVerdict({
      // "incumbent" is itself noise ⇒ no discrimination.
      incumbent: await runArm("incumbent", corpus, noiseEmbed),
      candidate: await runArm("candidate", corpus, oracleEmbed),
      "wrong-pooling": await runArm("wrong", corpus, degradedEmbed),
      "hash-floor": await runArm("hash", corpus, noiseEmbed),
    });
    expect(verdict.outcome).toBe("INVALID");
    expect(verdict.checks.find((c) => c.id === "discriminates-noise")?.passed).toBe(false);
  });
});

describe("embedBatched", () => {
  it("splits into batches and preserves order", async () => {
    const seen: number[] = [];
    const vectors = await embedBatched(
      ["a", "b", "c", "d", "e"],
      async (texts) => {
        seen.push(texts.length);
        return texts.map((t) => [t.charCodeAt(0)]);
      },
      2,
    );
    expect(seen).toEqual([2, 2, 1]);
    expect(vectors.map((v) => v[0])).toEqual(["a", "b", "c", "d", "e"].map((t) => t.charCodeAt(0)));
  });

  it("throws when the embedder returns the wrong number of vectors", async () => {
    await expect(embedBatched(["a", "b"], async () => [[1]], 2)).rejects.toThrow(
      /returned 1 vectors for 2 texts/,
    );
  });
});

describe("createMemoryVectorStore", () => {
  it("returns the top-k nearest rows by cosine, ties broken by symbol id", async () => {
    const store = createMemoryVectorStore([
      { symbolId: "b", filePath: "b.ts", vector: [1, 0] },
      { symbolId: "a", filePath: "a.ts", vector: [1, 0] },
      { symbolId: "far", filePath: "far.ts", vector: [0, 1] },
    ]);
    const hits = await store.search("p1", [1, 0], 2);
    expect(hits.map((h) => h.metadata.symbolId)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// #1157 — the weights-free lexical baseline.
// ---------------------------------------------------------------------------

describe("runLexicalBaseline", () => {
  it("ranks by BM25 alone and scores every query", async () => {
    const corpus = makeCorpus();
    const scores = await runLexicalBaseline(corpus);
    expect(scores.map((s) => s.queryId)).toEqual(corpus.queries.map((q) => q.id));
    // Each query's topic word is in its target's NAME, so BM25 finds it.
    expect(scores.every((s) => s.firstRelevantRank === 1)).toBe(true);
  });

  // It must be the SAME number `runArm` reports as its bm25 reference line —
  // otherwise the weights-free arm is characterising a different corpus from the
  // one the weight-bearing arms are scored on, and the two cannot be read together.
  it("reproduces the bm25 reference channel `runArm` computes, for BOTH embedders", async () => {
    const corpus = makeCorpus();
    const lexical = aggregate(await runLexicalBaseline(corpus));
    const viaOracle = await runArm("oracle", corpus, oracleEmbed);
    const viaNoise = await runArm("noise", corpus, noiseEmbed);
    expect(lexical.ndcgAtK[10]).toBeCloseTo(viaOracle.channels.bm25.ndcgAtK[10]!, 12);
    expect(lexical.ndcgAtK[10]).toBeCloseTo(viaNoise.channels.bm25.ndcgAtK[10]!, 12);
    expect(lexical.mrr).toBeCloseTo(viaOracle.channels.bm25.mrr, 12);
  });

  // The tripwire, with a POSITIVE CONTROL — because a throwing embed service is
  // NOT on its own a guard here: `HybridCodeSearch.search` catches everything the
  // vector branch throws, logs "falling back to BM25-only" and carries on. So a
  // thrown error alone leaves every metric identical and the run green.
  //
  // The pair below is what makes the guard real. The first asserts the default
  // setting reaches no embedder; the second forces the vector branch open and
  // proves the detection actually fires — without it, deleting the `embedCalls`
  // check would turn nothing red.
  it("reaches NO embedder at the default lexical-only weights", async () => {
    const corpus = makeCorpus();
    await expect(runLexicalBaseline(corpus)).resolves.toHaveLength(corpus.queries.length);
  });

  it("POSITIVE CONTROL: throws if the vector branch is opened, despite the searcher swallowing it", async () => {
    const corpus = makeCorpus();
    await expect(runLexicalBaseline(corpus, { bm25Weight: 1, vectorWeight: 1 })).rejects.toThrow(
      /reached an embedder/,
    );
  });

  it("returns nothing for a corpus with no queries", async () => {
    const corpus = { ...makeCorpus(), queries: [] };
    expect(await runLexicalBaseline(corpus)).toEqual([]);
  });
});
