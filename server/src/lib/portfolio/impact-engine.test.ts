/**
 * #1623 — the impact engine's pure parts: edge semantics, the direct-change
 * set and how an impact is merged into an assessment record. The walk itself,
 * over a real database, is in `tests/portfolio-impact-1623.sqlite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { PortfolioAssessmentInput } from "@metis/shared";
import {
  directChangeProductIds,
  edgeFlows,
  otherLinkKinds,
  withImpact,
  type PortfolioImpactResult,
  type ProductImpact,
} from "./impact-engine.js";
import { impactSentence } from "./report-overview.js";

describe("edgeFlows", () => {
  const flows = (direction: string | null, targetRepoId: string | null = "t") =>
    edgeFlows({ sourceRepoId: "s", targetRepoId, direction });

  it("a consumer or dependant source is downstream of its target", () => {
    expect(flows("consumes")).toEqual([{ provider: "t", consumer: "s" }]);
    expect(flows("depends-on")).toEqual([{ provider: "t", consumer: "s" }]);
  });

  it("a providing or writing source has its target downstream", () => {
    expect(flows("provides")).toEqual([{ provider: "s", consumer: "t" }]);
    expect(flows("writes")).toEqual([{ provider: "s", consumer: "t" }]);
  });

  it("two readers, or an unclassified edge, carry impact both ways", () => {
    const both = [
      { provider: "s", consumer: "t" },
      { provider: "t", consumer: "s" },
    ];
    expect(flows("reads")).toEqual(both);
    expect(flows(null)).toEqual(both);
    expect(flows("sideways")).toEqual(both);
  });

  it("a write between two writers of a table carries impact both ways (#1668)", () => {
    const evidence = (...patterns: string[]) =>
      JSON.stringify(patterns.map((pattern, i) => ({ filePath: `f${i}.sql`, pattern })));
    const writes = (raw: string | null) =>
      edgeFlows({ sourceRepoId: "s", targetRepoId: "t", direction: "writes", evidence: raw });
    expect(writes(evidence("sql_table_write", "sql_table_write"))).toEqual([
      { provider: "s", consumer: "t" },
      { provider: "t", consumer: "s" },
    ]);
    // A writer and a reader: only the writer's change reaches the reader.
    expect(writes(evidence("sql_table_write", "sql_table_read"))).toEqual([
      { provider: "s", consumer: "t" },
    ]);
    expect(writes(null)).toEqual([{ provider: "s", consumer: "t" }]);
    expect(writes("not json")).toEqual([{ provider: "s", consumer: "t" }]);
    // `provides` stays one way whatever its evidence says.
    expect(
      edgeFlows({
        sourceRepoId: "s",
        targetRepoId: "t",
        direction: "provides",
        evidence: evidence("sql_table_write", "sql_table_write"),
      }),
    ).toEqual([{ provider: "s", consumer: "t" }]);
  });

  it("an edge to a resource alone carries nothing by itself", () => {
    expect(flows("writes", null)).toEqual([]);
  });
});

describe("directChangeProductIds", () => {
  const gap = {
    products: [
      { productId: "p2", coverage: "partial" },
      { productId: "p1", coverage: "covers" },
      { productId: "p3", coverage: "not-covered" },
      { productId: "p4", coverage: "partial" },
    ],
  } as Parameters<typeof directChangeProductIds>[0];

  it("the partly-covering products change; one that covers it already does not", () => {
    expect(directChangeProductIds(gap)).toEqual(["p2", "p4"]);
  });

  it("the host changes too, once, whether or not it was in scope", () => {
    expect(directChangeProductIds(gap, "p3")).toEqual(["p2", "p3", "p4"]);
    expect(directChangeProductIds(gap, "p2")).toEqual(["p2", "p4"]);
    expect(directChangeProductIds({ products: [] }, "p9")).toEqual(["p9"]);
  });
});

const impactOf = (over: Partial<ProductImpact> & { productId: string }): ProductImpact => ({
  name: "N",
  restricted: false,
  impactKind: "none",
  via: null,
  severity: null,
  edgeIds: [],
  hops: [],
  hiddenEdgeCount: 0,
  links: [],
  edgesDetected: false,
  ...over,
});

describe("impactSentence", () => {
  it("says how a product is reached", () => {
    expect(impactSentence(impactOf({ productId: "p", impactKind: "direct-change" }))).toBe(
      "Must change to deliver this requirement.",
    );
    expect(impactSentence(impactOf({ productId: "p" }))).toBe("Not affected.");
    // #1673 — reached, or maybe reached, only through a restricted product.
    expect(impactSentence(impactOf({ productId: "p", impactKind: "restricted" }))).toBe(
      "May be reached through a restricted product.",
    );
    expect(
      impactSentence(
        impactOf({
          productId: "p",
          impactKind: "downstream-consumer",
          via: "api",
          severity: "low",
        }),
      ),
    ).toBe("Downstream consumer via api (low).");
    expect(impactSentence(impactOf({ productId: "p", impactKind: "downstream-consumer" }))).toBe(
      "Downstream consumer.",
    );
  });

  it("#1963 — names every other edge kind the change reaches it by", () => {
    const p = impactOf({
      productId: "p",
      impactKind: "downstream-consumer",
      via: "database",
      severity: "high",
    });
    expect(impactSentence(p, ["event", "api"])).toBe(
      "Downstream consumer via database (high). Also via event, api.",
    );
    expect(impactSentence(p, [])).toBe("Downstream consumer via database (high).");
  });
});

describe("otherLinkKinds (#1963)", () => {
  const link = (integrationKind: ProductImpact["links"][number]["integrationKind"]) => ({
    integrationKind,
    fromProductId: "p1",
    edgeProductIds: ["p2"],
    providerRepoId: "rc-1",
    consumerRepoId: "rc-2",
  });

  it("is each kind but the shown path's, once, in the integration kinds' order", () => {
    const links = [link("database"), link("event"), link("api"), link("event")];
    expect(otherLinkKinds({ via: "database", links })).toEqual(["api", "event"]);
    expect(otherLinkKinds({ via: null, links })).toEqual(["api", "event", "database"]);
    expect(otherLinkKinds({ via: "api", links: [link("api")] })).toEqual([]);
  });

  it("withImpact stores the links, and an out-of-scope row's sentence names every kind", () => {
    const links = [link("database"), link("event")];
    const out = withImpact(
      { statement: "S", scope: "product", productIds: ["p1"], createdById: "u", products: [] },
      {
        maxDepth: 2,
        stoppedAtRestricted: 0,
        products: [
          impactOf({
            productId: "p2",
            impactKind: "downstream-consumer",
            via: "database",
            severity: "high",
            links,
          }),
        ],
      },
    ).products![0];
    expect(out.baSummary).toBe("Downstream consumer via database (high). Also via event.");
    expect((out.technicalDetail as { impact: { links: unknown } }).impact.links).toEqual(links);
  });
});

describe("withImpact", () => {
  const input: PortfolioAssessmentInput = {
    statement: "S",
    scope: "all-accessible",
    productIds: ["p1", "p2", "p3"],
    createdById: "u",
    products: [
      { productId: "p1", coverage: "partial", technicalDetail: { reason: null } },
      { productId: "p2", coverage: "not-covered", technicalDetail: { reason: null } },
      { productId: "p3", coverage: "restricted" },
    ],
  };
  const impact: PortfolioImpactResult = {
    maxDepth: 2,
    // p9: the walk reached it and stopped there.
    stoppedAtRestricted: 1,
    products: [
      impactOf({ productId: "p1", impactKind: "direct-change", hiddenEdgeCount: 2 }),
      impactOf({
        productId: "p2",
        impactKind: "downstream-consumer",
        via: "api",
        severity: "low",
        edgeIds: ["e1"],
      }),
      // Restricted to the run, though it came back with something: nothing of it is stored.
      impactOf({
        productId: "p3",
        restricted: false,
        impactKind: "downstream-consumer",
        via: "event",
        severity: "high",
        edgeIds: ["e2"],
      }),
      impactOf({
        productId: "p8",
        impactKind: "downstream-consumer",
        via: "database",
        severity: "high",
        edgeIds: ["e3"],
      }),
      impactOf({ productId: "p9", restricted: true, impactKind: "downstream-consumer" }),
      impactOf({ productId: "p10" }),
      // #1725 — holds the host's repo, outside the scope.
      impactOf({ productId: "p11", impactKind: "direct-change" }),
    ],
  };
  const rows = () => withImpact(input, impact).products!;
  const row = (id: string) => rows().find((p) => p.productId === id);

  it("adds each scoped product's impact, keeping its gap detail", () => {
    expect(row("p1")).toEqual(
      expect.objectContaining({
        coverage: "partial",
        impactKind: "direct-change",
        technicalDetail: {
          reason: null,
          impact: {
            maxDepth: 2,
            severity: null,
            severityRule: "weakest-hop",
            hiddenEdgeCount: 2,
            stoppedAtRestricted: 1,
            // #1689 — the rule this run relabelled by; `adjacent` is the older one.
            restrictedRule: "walk",
            hops: [],
            links: [],
            // #1963 — whether its edges were ever detected (a completed product analysis).
            edgesDetected: false,
          },
        },
      }),
    );
    expect(row("p2")).toEqual(
      expect.objectContaining({ via: "api", severity: "low", edgeIds: ["e1"] }),
    );
    // #1668 — a walk that stopped nowhere records no stop. #1692 — but it records
    // its rule: such a run relabels too, when it could not read a repo or an edge.
    const clean = withImpact(input, { ...impact, stoppedAtRestricted: 0 }).products!;
    expect(clean[0].technicalDetail!.impact).not.toHaveProperty("stoppedAtRestricted");
    expect(clean[0].technicalDetail!.impact).toHaveProperty("restrictedRule", "walk");
  });

  it("a product restricted to the run gets its impact kind and nothing else", () => {
    expect(row("p3")).toEqual({
      productId: "p3",
      coverage: "restricted",
      impactKind: "downstream-consumer",
      via: null,
      edgeIds: [],
      severity: null,
    });
  });

  it("a downstream product outside the scope gets its own row; one not reached does not", () => {
    expect(row("p8")).toEqual(
      expect.objectContaining({
        coverage: "not-checked",
        impactKind: "downstream-consumer",
        baSummary: "Downstream consumer via database (high).",
        technicalDetail: expect.objectContaining({ outOfScope: true }),
      }),
    );
    expect(row("p9")).toEqual({
      productId: "p9",
      coverage: "restricted",
      impactKind: "downstream-consumer",
      via: null,
      edgeIds: [],
      severity: null,
      baSummary: "",
      technicalDetail: {},
    });
    expect(row("p10")).toBeUndefined();
    // #1725 — a product holding the host's repo, outside the scope, changes directly.
    expect(row("p11")).toEqual(
      expect.objectContaining({
        coverage: "not-checked",
        impactKind: "direct-change",
        baSummary: "Must change to deliver this requirement.",
        technicalDetail: expect.objectContaining({ outOfScope: true }),
      }),
    );
    // The scope itself is unchanged: the new rows never enter the portfolio verdict.
    expect(withImpact(input, impact).productIds).toEqual(["p1", "p2", "p3"]);
  });
});
