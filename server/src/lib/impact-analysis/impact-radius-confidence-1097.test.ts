/**
 * #1097 — with absolute seed confidences, WHICH callers the blast radius
 * reaches stays structural (it walks from a seed of 1, as it did when every
 * best hit read 1.0), and HOW SURE each caller is follows the best seed.
 */
import { describe, expect, it } from "vitest";
import { InMemoryCodeGraphDataSource, computeProjectImpact } from "./impact-analysis-engine.js";

const sym = (id: string) => ({
  id,
  qualifiedName: `${id}.go::${id}`,
  kind: "function",
  filePath: `${id}.go`,
  language: "go",
  startLine: 1,
  endLine: 5,
});

const graph = new InMemoryCodeGraphDataSource(
  [sym("seed"), sym("caller"), sym("grandcaller")],
  [
    { id: "e1", fromSymbolId: "caller", toSymbolId: "seed", kind: "calls" },
    { id: "e2", fromSymbolId: "grandcaller", toSymbolId: "caller", kind: "calls" },
  ],
);

async function impactWithSeedConfidence(confidence: number) {
  return computeProjectImpact(
    {
      requirementId: "r",
      title: "t",
      body: "t",
      changeType: "added",
      bodyDelta: 1,
    },
    "p",
    {
      mapRequirement: async () => [
        {
          codeSymbolId: "seed",
          filePath: "seed.go",
          qualifiedName: "seed.go::seed",
          startLine: 1,
          endLine: 5,
          confidence,
        },
      ],
      dataSourceFor: () => graph,
      includeSchemaImpact: false,
    },
  );
}

describe("blast radius under absolute confidence (#1097)", () => {
  it("reaches the same callers whatever the seed's confidence", async () => {
    const strong = await impactWithSeedConfidence(1);
    const weak = await impactWithSeedConfidence(0.3);
    const names = (r: Awaited<ReturnType<typeof impactWithSeedConfidence>>) =>
      r.affectedSymbols.map((s) => s.qualifiedName);
    expect(names(weak)).toEqual(names(strong));
    // A 0.3 seed walked from 0.3 would have dropped its callers under the 0.4 radius floor.
    expect(names(weak)).toEqual([
      "seed.go::seed",
      "caller.go::caller",
      "grandcaller.go::grandcaller",
    ]);
  });

  it("scales each caller's confidence by its seed's: never surer than the link it came by", async () => {
    const weak = await impactWithSeedConfidence(0.3);
    const by = new Map(weak.affectedSymbols.map((s) => [s.qualifiedName, s.confidence]));
    expect(by.get("seed.go::seed")).toBe(0.3);
    expect(by.get("caller.go::caller")).toBeCloseTo(0.3, 10);
    expect(by.get("grandcaller.go::grandcaller")).toBeCloseTo(0.21, 10);
  });

  it("with several seeds, scales each caller by the seed it was REACHED through (review of PR #1325)", async () => {
    // strong <- a <- aa ; weak <- b ; both <- strong AND weak
    const two = new InMemoryCodeGraphDataSource(
      ["strong", "weak", "a", "aa", "b", "both"].map(sym),
      [
        { id: "e1", fromSymbolId: "a", toSymbolId: "strong", kind: "calls" },
        { id: "e2", fromSymbolId: "aa", toSymbolId: "a", kind: "calls" },
        { id: "e3", fromSymbolId: "b", toSymbolId: "weak", kind: "calls" },
        { id: "e4", fromSymbolId: "both", toSymbolId: "weak", kind: "calls" },
        { id: "e5", fromSymbolId: "both", toSymbolId: "strong", kind: "calls" },
      ],
    );
    const match = (id: string, confidence: number) => ({
      codeSymbolId: id,
      filePath: `${id}.go`,
      qualifiedName: `${id}.go::${id}`,
      startLine: 1,
      endLine: 5,
      confidence,
    });
    const impact = await computeProjectImpact(
      { requirementId: "r", title: "t", body: "t", changeType: "added", bodyDelta: 1 },
      "p",
      {
        mapRequirement: async () => [match("strong", 0.45), match("weak", 0.08)],
        dataSourceFor: () => two,
        includeSchemaImpact: false,
      },
    );
    const by = new Map(impact.affectedSymbols.map((s) => [s.qualifiedName, s.confidence]));
    expect(by.get("a.go::a")).toBeCloseTo(0.45, 10);
    expect(by.get("aa.go::aa")).toBeCloseTo(0.45 * 0.7, 10);
    // Reached only through the 0.08 seed: it reads 0.08, not the best seed's 0.45.
    expect(by.get("b.go::b")).toBeCloseTo(0.08, 10);
    // Reached through both at the same depth: the better path wins.
    expect(by.get("both.go::both")).toBeCloseTo(0.45, 10);
  });
});
