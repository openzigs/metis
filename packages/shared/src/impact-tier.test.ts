/**
 * #2302 — the tier of each affected symbol and table in Impact Analysis, in the
 * same four words as the portfolio check's (#2272), from what a run stored.
 */
import { describe, expect, it } from "vitest";
import {
  IMPACT_TIERS,
  IMPACT_TIER_LABEL,
  IMPACT_GRAPH_RELATIONS,
  IMPACT_LIKELY_CONFIDENCE,
  IMPACT_VERIFIED_CONFIDENCE,
  IMPACT_VERIFIED_MAX_DEPTH,
  impactSymbolTier,
  impactTableTier,
} from "./impact-tier.js";
import { IMPACT_AFFECTED_RELATIONS, type ImpactAffectedRelation } from "./impact.js";
import { PORTFOLIO_IMPACT_TIER_LABEL } from "./portfolio-assessment.js";

const sym = (
  over: Partial<{
    codeSymbolId: string | null;
    relation: ImpactAffectedRelation;
    depth: number;
    confidence: number;
  }> = {},
) => ({
  codeSymbolId: "cs-1",
  relation: "caller" as ImpactAffectedRelation,
  depth: 1,
  confidence: 1,
  ...over,
});

describe("#2302 — the four tiers", () => {
  it("are the portfolio check's words, without its code-verdict tier", () => {
    expect(IMPACT_TIERS).toEqual(["verified", "likely", "possible", "needs-review"]);
    for (const t of IMPACT_TIERS) expect(IMPACT_TIER_LABEL[t]).toBe(PORTFOLIO_IMPACT_TIER_LABEL[t]);
    expect(IMPACT_TIER_LABEL.verified).toBe("Verified by graph path");
  });

  it("name every graph relation, and never a retrieval one", () => {
    for (const r of IMPACT_GRAPH_RELATIONS) expect(IMPACT_AFFECTED_RELATIONS).toContain(r);
    expect(IMPACT_GRAPH_RELATIONS).not.toContain("direct");
    expect(IMPACT_GRAPH_RELATIONS).not.toContain("related");
  });

  it("verify only along edges whose confidence is a product of edge strengths", () => {
    // Literal, so dropping (or adding) a relation fails here rather than passing silently.
    expect([...IMPACT_GRAPH_RELATIONS].sort()).toEqual(["caller", "dependency", "importer"]);
  });
});

describe("#2302 — impactSymbolTier", () => {
  it("verifies a graph-reached symbol one hop out with a strong path", () => {
    for (const relation of IMPACT_GRAPH_RELATIONS) {
      expect(
        impactSymbolTier(sym({ relation, depth: 1, confidence: IMPACT_VERIFIED_CONFIDENCE })),
      ).toBe("verified");
    }
  });

  it("never verifies a lineage writer: its confidence is its rank among the writers", () => {
    // `findDataPathWriters` scores 0.4 + 0.4 * points / best, so the best writer of every
    // run sits at exactly 0.8 whatever the evidence. Rank is not evidence.
    expect(impactSymbolTier(sym({ relation: "data-writer", depth: 1, confidence: 0.8 }))).toBe(
      "likely",
    );
    // Promoted to a file to edit (depth 0) it is still at most likely.
    expect(impactSymbolTier(sym({ relation: "data-writer", depth: 0, confidence: 0.8 }))).toBe(
      "likely",
    );
    expect(impactSymbolTier(sym({ relation: "data-writer", depth: 1, confidence: 0.4 }))).toBe(
      "possible",
    );
  });

  it("holds a table's definition at likely: its confidence is a fixed 0.6", () => {
    expect(impactSymbolTier(sym({ relation: "data-model", depth: 0, confidence: 0.6 }))).toBe(
      "likely",
    );
    expect(impactSymbolTier(sym({ relation: "data-model", depth: 0, confidence: 1 }))).toBe(
      "likely",
    );
  });

  it("does not verify past one hop, however confident", () => {
    expect(impactSymbolTier(sym({ depth: IMPACT_VERIFIED_MAX_DEPTH + 1, confidence: 1 }))).toBe(
      "likely",
    );
  });

  it("does not verify a graph-reached symbol below the verified confidence", () => {
    expect(impactSymbolTier(sym({ confidence: IMPACT_VERIFIED_CONFIDENCE - 0.01 }))).toBe("likely");
    expect(impactSymbolTier(sym({ confidence: IMPACT_LIKELY_CONFIDENCE }))).toBe("likely");
    expect(impactSymbolTier(sym({ confidence: IMPACT_LIKELY_CONFIDENCE - 0.01 }))).toBe("possible");
  });

  it("never verifies a search match: likely or possible by its confidence", () => {
    expect(impactSymbolTier(sym({ relation: "direct", depth: 0, confidence: 1 }))).toBe("likely");
    expect(
      impactSymbolTier(sym({ relation: "direct", depth: 0, confidence: IMPACT_LIKELY_CONFIDENCE })),
    ).toBe("likely");
    expect(impactSymbolTier(sym({ relation: "direct", depth: 0, confidence: 0.49 }))).toBe(
      "possible",
    );
  });

  it("holds a related symbol (below the edit cut) at possible", () => {
    expect(impactSymbolTier(sym({ relation: "related", depth: 1, confidence: 1 }))).toBe(
      "possible",
    );
  });

  it("asks for review when the target no longer resolves to the code graph", () => {
    expect(impactSymbolTier(sym({ codeSymbolId: null }))).toBe("needs-review");
    expect(impactSymbolTier(sym({ codeSymbolId: null, relation: "direct", depth: 0 }))).toBe(
      "needs-review",
    );
  });

  it("asks for review when the stored confidence is not a number", () => {
    expect(impactSymbolTier(sym({ confidence: Number.NaN }))).toBe("needs-review");
  });
});

describe("#2302 — impactTableTier", () => {
  const table = (
    over: Partial<{
      reconciliation: "matched" | "table-not-found" | "column-not-found" | null;
      relevanceTier: "likely" | "possible" | "unlikely" | null;
      confidence: number;
    }> = {},
  ) => ({ reconciliation: null, relevanceTier: null, confidence: 0.3, ...over });

  it("maps the relevance tier into the four words", () => {
    expect(impactTableTier(table({ relevanceTier: "likely" }))).toBe("likely");
    expect(impactTableTier(table({ relevanceTier: "possible", confidence: 0.9 }))).toBe("possible");
    expect(impactTableTier(table({ relevanceTier: "unlikely", confidence: 0.9 }))).toBe("possible");
  });

  it("reads an unjudged row by its confidence", () => {
    expect(impactTableTier(table({ confidence: IMPACT_LIKELY_CONFIDENCE }))).toBe("likely");
    expect(impactTableTier(table({ confidence: IMPACT_LIKELY_CONFIDENCE - 0.01 }))).toBe(
      "possible",
    );
    expect(impactTableTier({ reconciliation: "matched", confidence: 0.9 })).toBe("likely");
  });

  it("asks for review when the table or column is not in the live schema", () => {
    expect(
      impactTableTier(table({ reconciliation: "table-not-found", relevanceTier: "likely" })),
    ).toBe("needs-review");
    expect(
      impactTableTier(table({ reconciliation: "column-not-found", relevanceTier: "likely" })),
    ).toBe("needs-review");
    expect(impactTableTier(table({ confidence: Number.NaN }))).toBe("needs-review");
  });

  it("never verifies a table: the row keeps no path", () => {
    expect(
      impactTableTier(table({ reconciliation: "matched", relevanceTier: "likely", confidence: 1 })),
    ).toBe("likely");
  });
});
