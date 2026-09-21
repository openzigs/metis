import { describe, expect, it } from "vitest";
import { ARMS, armByRole, createArmEmbedFn, HASH_MODEL } from "./arms.js";
import type { ChannelMetrics } from "./metrics.js";
import { renderReport, toJsonArtifact, type RenderInput } from "./report.js";
import type { ArmRunResult } from "./runner.js";
import { bootstrapMean, computeSignificance } from "./stats.js";
import { computeVerdict } from "./verdict.js";

function channel(n: number): ChannelMetrics {
  return {
    queryCount: 30,
    recallAtK: { 1: n, 5: n, 10: n },
    mrr: n,
    ndcgAtK: { 1: n, 5: n, 10: n },
    hitRateAt10: n,
  };
}

function result(id: string, n: number): ArmRunResult {
  return {
    armId: id,
    channels: { vector: channel(n), hybrid: channel(n + 0.1), bm25: channel(0.4) },
    vectorQueries: [
      {
        queryId: "Q01",
        ranked: ["a"],
        relevant: ["a"],
        firstRelevantRank: 1,
        recallAtK: { 5: 1 },
        reciprocalRank: 1,
        ndcgAtK: { 10: 1 },
      },
    ],
    docCount: 183,
    queryCount: 30,
  };
}

function makeInput(): RenderInput {
  const byRole = {
    incumbent: result("A", 0.5),
    candidate: result("B", 0.62),
    "wrong-pooling": result("C", 0.5),
    "hash-floor": result("E", 0.05),
  };
  return {
    corpusId: "embedretrieval-01-nl-to-code",
    docCount: 183,
    queryCount: 30,
    ranAt: "2026-07-13T00:00:00.000Z",
    results: [
      { spec: armByRole("incumbent"), result: byRole.incumbent },
      { spec: armByRole("candidate"), result: byRole.candidate },
      { spec: armByRole("wrong-pooling"), result: byRole["wrong-pooling"] },
      { spec: armByRole("hash-floor"), result: byRole["hash-floor"] },
    ],
    verdict: computeVerdict(byRole),
    significance: computeSignificance(byRole, { resamples: 200 }),
    // #1157 — required, not optional: a results file whose headline number has
    // no interval is the defect the issue exists to fix.
    headline: {
      armId: "B",
      ci: bootstrapMean([0.2, 0.9, 0.4, 0.7, 0.55], { resamples: 500 }),
      strata: [
        {
          key: "naming",
          value: "snake",
          queryCount: 23,
          ndcgAt10: 0.31,
          mrr: 0.28,
          perQueryNdcgAt10: [],
        },
        {
          key: "keywordFree",
          value: "true",
          queryCount: 88,
          ndcgAt10: 0.44,
          mrr: 0.4,
          perQueryNdcgAt10: [],
        },
      ],
    },
  };
}

describe("renderReport", () => {
  it("renders a row per arm in each channel table, plus the verdict and honesty notes", () => {
    const md = renderReport(makeInput());
    expect(md).toContain("## Vector channel");
    expect(md).toContain("## Hybrid channel");
    expect(md).toContain("BM25-only reference line");
    expect(md).toContain("### Outcome: **GO**");
    for (const spec of ARMS.filter((a) => a.role !== "candidate-fp32")) {
      expect(md).toContain(spec.id);
    }
    expect(md).toContain("HAND-BUILT");
  });

  it("prints the BM25 line PER ARM with its spread, rather than asserting flatness in prose", () => {
    // The previous report printed ONE bm25 number and claimed in prose that it was
    // "identical across arms by construction" — while the channel was in fact
    // leaking vector hits and moving by 0.060 across arms. The property is now
    // shown, so a regression is visible in the table instead of hidden behind it.
    const md = renderReport(makeInput());
    expect(md).toContain("Spread across arms: 0.0000 nDCG@10");
    expect(md).not.toContain("identical across arms by construction");
  });

  it("renders the paired significance table (CI + sign test) for each headline comparison", () => {
    const md = renderReport(makeInput());
    expect(md).toContain("## Paired significance");
    expect(md).toContain("sign test p");
    expect(md).toContain("candidate beats incumbent (the gate)");
  });

  it("says that an underpowered CI is not evidence of equivalence", () => {
    const md = renderReport(makeInput());
    expect(md).toContain("cannot establish EQUIVALENCE");
    expect(md).toContain("no evidence q8 degrades retrieval");
  });

  it("renders every verdict check with a PASS/FAIL/n-a marker", () => {
    const md = renderReport(makeInput());
    expect(md).toContain("detects-wrong-pooling");
    expect(md).toContain("**PASS**");
    // the fp32 arm was not run in this input
    expect(md).toContain("q8-within-tolerance");
    expect(md).toContain("n/a");
  });

  it("omits the BM25 reference when no arms ran", () => {
    const input = { ...makeInput(), results: [] };
    expect(renderReport(input)).not.toContain("BM25-only reference line");
  });

  it("marks a failed check FAIL — a report that can only print PASS is useless", () => {
    const byRole = {
      incumbent: result("A", 0.5),
      candidate: result("B", 0.51), // below the +0.05 bar
      "wrong-pooling": result("C", 0.4),
      "hash-floor": result("E", 0.05),
    };
    const md = renderReport({
      ...makeInput(),
      results: [{ spec: armByRole("candidate"), result: byRole.candidate }],
      verdict: computeVerdict(byRole),
    });
    expect(md).toContain("**FAIL**");
    expect(md).toContain("### Outcome: **NO-GO**");
  });

  it("renders zeros rather than crashing when a cut-off was not measured", () => {
    const bare: ChannelMetrics = {
      queryCount: 0,
      recallAtK: {},
      mrr: 0,
      ndcgAtK: {},
      hitRateAt10: 0,
    };
    const armResult: ArmRunResult = {
      armId: "X",
      channels: { vector: bare, hybrid: bare, bm25: bare },
      vectorQueries: [],
      docCount: 0,
      queryCount: 0,
    };
    const input: RenderInput = {
      ...makeInput(),
      results: [{ spec: armByRole("incumbent"), result: armResult }],
    };
    expect(renderReport(input)).toContain("0.000");
    const json = toJsonArtifact(input) as {
      arms: Array<{ channels: { vector: { ndcgAt10: number; recallAt5: number } } }>;
    };
    expect(json.arms[0].channels.vector.ndcgAt10).toBe(0);
    expect(json.arms[0].channels.vector.recallAt5).toBe(0);
  });

  it("emits null pooling/dtype for an arm that has none (the hash floor)", () => {
    const input: RenderInput = {
      ...makeInput(),
      results: [{ spec: armByRole("hash-floor"), result: result("E", 0.03) }],
    };
    const json = toJsonArtifact(input) as {
      arms: Array<{ pooling: string | null; dtype: string | null }>;
    };
    expect(json.arms[0].pooling).toBeNull();
    expect(json.arms[0].dtype).toBeNull();
  });
});

describe("toJsonArtifact", () => {
  it("is machine-readable, carries the outcome, and rounds the metrics", () => {
    const json = toJsonArtifact(makeInput()) as {
      kind: string;
      outcome: string;
      arms: Array<{ id: string; role: string; channels: { vector: { ndcgAt10: number } } }>;
      checks: unknown[];
    };
    expect(json.kind).toBe("embed-retrieval-eval");
    expect(json.outcome).toBe("GO");
    expect(json.arms).toHaveLength(4);
    expect(json.arms[1].role).toBe("candidate");
    expect(json.arms[1].channels.vector.ndcgAt10).toBe(0.62);
    expect(json.checks.length).toBeGreaterThan(0);
  });

  it("carries the paired significance so #783 can cite an interval, not just a mean", () => {
    const json = toJsonArtifact(makeInput()) as {
      significance: Array<{
        armA: string;
        armB: string;
        metric: string;
        n: number;
        meanDelta: number;
        ciLow: number;
        ciHigh: number;
        signTestP: number;
      }>;
    };
    expect(json.significance).toHaveLength(3); // fp32 arm not run in this input
    const gate = json.significance[0];
    expect(gate.armA).toBe("B");
    expect(gate.armB).toBe("A");
    expect(gate.metric).toBe("vector.ndcgAt10");
    expect(typeof gate.ciLow).toBe("number");
    expect(typeof gate.signTestP).toBe("number");
  });
});

describe("arms", () => {
  it("defines the incumbent as the model that is actually the default today", () => {
    const incumbent = armByRole("incumbent");
    expect(incumbent.model).toBe("Xenova/bge-small-en-v1.5");
    expect(incumbent.pooling).toBe("mean");
    expect(incumbent.dimension).toBe(384);
  });

  it("defines the candidate with CLS pooling and the trap arm with mean pooling on the SAME model", () => {
    const candidate = armByRole("candidate");
    const trap = armByRole("wrong-pooling");
    expect(candidate.model).toBe("Alibaba-NLP/gte-modernbert-base");
    expect(candidate.pooling).toBe("cls");
    expect(trap.model).toBe(candidate.model);
    expect(trap.pooling).toBe("mean");
    expect(trap.dtype).toBe(candidate.dtype);
  });

  it("keeps a weights-free hash floor arm", () => {
    const floor = armByRole("hash-floor");
    expect(floor.backend).toBe("offline");
    expect(floor.requiresWeights).toBe(false);
    expect(floor.model).toBe(HASH_MODEL);
  });

  it("throws on an unknown role", () => {
    // @ts-expect-error — deliberately invalid role
    expect(() => armByRole("nope")).toThrow(/No arm defined/);
  });

  it("builds a working embed function for the weights-free arm", async () => {
    const embed = createArmEmbedFn(armByRole("hash-floor"));
    const vectors = await embed(["throttle repeated logins", "throttle repeated logins"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(384);
    // deterministic: the same text hashes to the same vector
    expect(vectors[0]).toEqual(vectors[1]);
  });
});

// ---------------------------------------------------------------------------
// #1157 — the interval and the strata are part of the artifact, not an add-on.
// ---------------------------------------------------------------------------

describe("renderReport — #1157 error bars", () => {
  it("renders the bootstrap CI section against the headline arm", () => {
    const md = renderReport(makeInput());
    expect(md).toContain("## Bootstrap 95% CI on `B` vector-channel nDCG@10");
    expect(md).toMatch(/\*\*±\d\.\d{4}\*\*/);
  });

  it("renders the per-stratum table WITH each stratum's denominator", () => {
    const md = renderReport(makeInput());
    expect(md).toContain("## Per-stratum results");
    expect(md).toContain("| `naming` | `snake` | 23 |");
    expect(md).toContain("| `keywordFree` | `true` | 88 |");
  });
});

describe("toJsonArtifact — #1157 error bars", () => {
  it("carries the interval and the strata machine-readably, so a later sub-issue can diff them", () => {
    const json = toJsonArtifact(makeInput()) as {
      headline: {
        armId: string;
        halfWidth: number;
        n: number;
        strata: Array<{ key: string; value: string; queryCount: number }>;
      };
    };
    expect(json.headline.armId).toBe("B");
    expect(json.headline.n).toBe(5);
    expect(json.headline.halfWidth).toBeGreaterThan(0);
    expect(json.headline.strata).toEqual([
      { key: "naming", value: "snake", queryCount: 23, ndcgAt10: 0.31, mrr: 0.28 },
      { key: "keywordFree", value: "true", queryCount: 88, ndcgAt10: 0.44, mrr: 0.4 },
    ]);
  });
});
