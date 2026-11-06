import { describe, expect, it } from "vitest";
import type { ChatCachePair } from "./fixture.js";
import {
  freshAgreement,
  pairSimilarities,
  replayAll,
  replaySemanticCache,
  type ReplayTurn,
} from "./semantic-replay.js";

/** A unit vector at `deg` degrees: cos(a − b) is the pair's similarity. */
const at = (deg: number): number[] => [
  Math.cos((deg * Math.PI) / 180),
  Math.sin((deg * Math.PI) / 180),
];
/** The angle whose cosine is `sim`. */
const angle = (sim: number): number => (Math.acos(sim) * 180) / Math.PI;

function turn(over: Partial<ReplayTurn> & Pick<ReplayTurn, "questionId">): ReplayTurn {
  return {
    pass: "before",
    text: over.questionId,
    embedding: at(0),
    response: `answer ${over.questionId}`,
    citedFiles: ["a.go"],
    toolCallCount: 2,
    stableSystemHash: "stable",
    ...over,
    scope: {
      model: "m",
      systemPromptHash: `rag-${over.questionId}`,
      projectId: "p",
      contentVersion: "v1",
      callerScope: "u",
      conversationHash: "c",
      ...over.scope,
    },
  };
}

const PAIRS: ChatCachePair[] = [
  { a: "q1", b: "q2", label: "paraphrase" },
  { a: "q1", b: "q3", label: "near-miss" },
  { a: "q1", b: "q4", label: "repeat" },
];

describe("replaySemanticCache", () => {
  it("shipped: a turn that used a tool is never stored, so nothing is served", async () => {
    const turns = [turn({ questionId: "q1" }), turn({ questionId: "q4", text: "q1" })];
    const r = await replaySemanticCache(turns, PAIRS, "shipped", 0.97);
    expect(r).toMatchObject({ lookups: 2, stored: 0, hits: 0, meanJaccard: null });
  });

  it("shipped: a tool-free turn is stored and an exact repeat is served from it", async () => {
    const turns = [
      turn({ questionId: "q1", toolCallCount: 0, scope: { systemPromptHash: "s" } as never }),
      turn({ questionId: "q4", text: "Q1 ", scope: { systemPromptHash: "s" } as never }),
    ];
    const r = await replaySemanticCache(turns, PAIRS, "shipped", 0.97);
    expect(r).toMatchObject({ stored: 1, hits: 1, exactHits: 1, wrongHits: 0 });
    expect(r.detail[0]).toMatchObject({ kind: "repeat", match: "exact", jaccard: 1 });
  });

  it("the shipped scope keeps two questions with different retrieval apart", async () => {
    const turns = [turn({ questionId: "q1" }), turn({ questionId: "q2", embedding: at(1) })];
    expect((await replaySemanticCache(turns, PAIRS, "store-tool-turns", 0.92)).hits).toBe(0);
    expect((await replaySemanticCache(turns, PAIRS, "question-only", 0.92)).hits).toBe(1);
  });

  it("serves a neighbour only at or above the threshold", async () => {
    const turns = [
      turn({ questionId: "q1" }),
      turn({ questionId: "q2", embedding: at(angle(0.96)) }),
    ];
    const hits = async (t: number) =>
      (await replaySemanticCache(turns, PAIRS, "question-only", t)).hits;
    expect(await hits(0.92)).toBe(1);
    expect(await hits(0.95)).toBe(1);
    expect(await hits(0.97)).toBe(0);
  });

  it("scores a near-miss hit with different cited files as wrong", async () => {
    const turns = [
      turn({ questionId: "q1", citedFiles: ["import.go"] }),
      turn({ questionId: "q3", embedding: at(angle(0.99)), citedFiles: ["export.go"] }),
    ];
    const r = await replaySemanticCache(turns, PAIRS, "question-only", 0.97);
    expect(r).toMatchObject({
      hits: 1,
      wrongHits: 1,
      byKind: { "near-miss": { hits: 1, wrong: 1 } },
    });
    expect(r.detail[0]).toMatchObject({
      servedFrom: { pass: "before", questionId: "q1" },
      jaccard: 0,
    });
  });

  it("a paraphrase hit with the same cited files is right; an unpaired one is unrelated", async () => {
    const turns = [
      turn({ questionId: "q1" }),
      turn({ questionId: "q2", embedding: at(angle(0.98)) }),
      turn({ questionId: "q9", embedding: at(-angle(0.98)) }),
    ];
    const r = await replaySemanticCache(turns, PAIRS, "question-only", 0.97);
    expect(r.byKind).toEqual({
      paraphrase: { hits: 1, wrong: 0 },
      unrelated: { hits: 1, wrong: 0 },
    });
  });

  it("the content version stops an answer from before the re-ingest being served after it", async () => {
    const after = { contentVersion: "v2" } as never;
    const turns = [
      turn({ questionId: "q1", citedFiles: ["old.go"] }),
      turn({ questionId: "q1", pass: "after", citedFiles: ["new.go"], scope: after }),
    ];
    expect((await replaySemanticCache(turns, PAIRS, "question-only", 0.97)).hits).toBe(0);
    const r = await replaySemanticCache(turns, PAIRS, "unversioned", 0.97);
    expect(r).toMatchObject({ hits: 1, exactHits: 1, wrongHits: 1, staleHits: 0, meanJaccard: 0 });
    expect(r.detail[0].kind).toBe("after-reingest");
  });

  it("counts a hit across the re-ingest as stale when the fresh answer cites a file the re-ingest made", async () => {
    const after = { contentVersion: "v2" } as never;
    const turns = [
      turn({ questionId: "q1", citedFiles: ["rewrite.go"] }),
      turn({
        questionId: "q1",
        pass: "after",
        citedFiles: ["rewrite.go", "video.go"],
        scope: after,
      }),
      turn({ questionId: "q2", embedding: at(90), citedFiles: ["x.go"] }),
      turn({
        questionId: "q2",
        embedding: at(90),
        pass: "after",
        citedFiles: ["y.go"],
        scope: after,
      }),
    ];
    const r = await replaySemanticCache(turns, PAIRS, "unversioned", 0.97, ["video.go"]);
    expect(r).toMatchObject({ hits: 2, wrongHits: 2, staleHits: 1 });
    expect(r.meanJaccard).toBe(0.25);
    // Without the patch's files named, nothing can be called stale.
    expect((await replaySemanticCache(turns, PAIRS, "unversioned", 0.97)).staleHits).toBe(0);
    // A hit within one pass is never stale.
    const same = turns.map((t) => ({
      ...t,
      pass: "before",
      scope: { ...t.scope, contentVersion: "v1" },
    }));
    expect(
      (await replaySemanticCache(same, PAIRS, "question-only", 0.97, ["video.go"])).staleHits,
    ).toBe(0);
  });

  it("a hit is not stored: a later lookup is served from the first entry", async () => {
    const turns = [
      turn({ questionId: "q1", citedFiles: ["x.go"] }),
      turn({ questionId: "q4", text: "q1", citedFiles: ["y.go"] }),
      turn({ questionId: "q4", text: "q1", pass: "again", citedFiles: ["y.go"] }),
    ];
    const r = await replaySemanticCache(turns, PAIRS, "question-only", 0.97);
    expect(r.stored).toBe(1);
    expect(r.detail.map((d) => d.servedFrom.questionId)).toEqual(["q1", "q1"]);
  });
});

describe("replayAll", () => {
  it("runs every variant at every threshold", async () => {
    const out = await replayAll([turn({ questionId: "q1" })], PAIRS);
    expect(out).toHaveLength(12);
    expect(new Set(out.map((r) => `${r.variant}@${r.threshold}`)).size).toBe(12);
  });
});

describe("freshAgreement / pairSimilarities", () => {
  it("counts the pairs whose fresh answers cite the same files, per pass", () => {
    const turns = [
      turn({ questionId: "q1", citedFiles: ["a.go"] }),
      turn({ questionId: "q2", citedFiles: ["a.go"] }),
      turn({ questionId: "q3", citedFiles: ["b.go"] }),
      turn({ questionId: "q1", pass: "after", citedFiles: ["a.go"] }),
      turn({ questionId: "q2", pass: "after", citedFiles: ["c.go"] }),
    ];
    expect(freshAgreement(turns, PAIRS)).toEqual([
      { pass: "before", label: "paraphrase", pairs: 1, sameFiles: 1, meanJaccard: 1 },
      { pass: "before", label: "near-miss", pairs: 1, sameFiles: 0, meanJaccard: 0 },
      { pass: "after", label: "paraphrase", pairs: 1, sameFiles: 0, meanJaccard: 0 },
    ]);
  });

  it("reports each pair's cosine, skipping a pair with a missing embedding", () => {
    const sims = pairSimilarities(
      PAIRS,
      new Map([
        ["q1", at(0)],
        ["q2", at(angle(0.9))],
        ["q3", at(90)],
      ]),
    );
    expect(sims.map((s) => [s.b, s.similarity])).toEqual([
      ["q2", 0.9],
      ["q3", 0],
    ]);
  });
});
