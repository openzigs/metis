/**
 * #2302 — the tier measurement's pure half: seeds tiered as the engine stores
 * them, and hit rates per tier.
 */
import { describe, expect, it } from "vitest";
import {
  seedTierObservations,
  tierPrecision,
  tierPrecisionMarkdown,
  type TierObservation,
} from "./impact-tiers.js";

const m = (filePath: string, confidence: number, codeSymbolId: string | null = "cs") => ({
  codeSymbolId,
  filePath,
  confidence,
});

describe("#2302 — seedTierObservations", () => {
  it("tiers edit candidates as direct matches and the rest as related", () => {
    const obs = seedTierObservations(
      "loc",
      {
        editCandidates: [m("a.go", 1), m("b.go", 0.3), m("c.go", 1, null)],
        related: [m("a.go", 1)],
        schemaSeeds: [m("t.sql", 0.9)],
      },
      (f) => f === "a.go",
    );
    expect(obs).toEqual([
      { source: "loc", tier: "likely", hit: true },
      { source: "loc", tier: "possible", hit: false },
      { source: "loc", tier: "needs-review", hit: false },
      { source: "loc", tier: "possible", hit: true },
      { source: "loc", tier: "possible", hit: false },
    ]);
  });
});

describe("#2302 — tierPrecision", () => {
  const obs: TierObservation[] = [
    { source: "a", tier: "likely", hit: true },
    { source: "a", tier: "likely", hit: false },
    { source: "a", tier: "possible", hit: false },
    { source: "b", tier: "verified", hit: true },
  ];

  it("counts each source's tiers in tier order, an empty tier with no rate", () => {
    const rows = tierPrecision(obs);
    expect(rows.map((r) => `${r.source}:${r.tier}`)).toEqual([
      "a:verified",
      "a:likely",
      "a:possible",
      "a:needs-review",
      "b:verified",
      "b:likely",
      "b:possible",
      "b:needs-review",
    ]);
    expect(rows[0]).toEqual({ source: "a", tier: "verified", count: 0, hits: 0, precision: null });
    expect(rows[1]).toEqual({ source: "a", tier: "likely", count: 2, hits: 1, precision: 0.5 });
    expect(rows[2]).toMatchObject({ count: 1, hits: 0, precision: 0 });
    expect(rows[4]).toMatchObject({ count: 1, hits: 1, precision: 1 });
  });

  it("renders the tier's label, and a dash for an empty tier", () => {
    const md = tierPrecisionMarkdown(tierPrecision(obs));
    expect(md).toContain("| a | Likely | 2 | 1 | 0.50 |");
    expect(md).toContain("| a | Verified by graph path | 0 | 0 | — |");
    expect(md.startsWith("| Reading | Tier |")).toBe(true);
  });
});
