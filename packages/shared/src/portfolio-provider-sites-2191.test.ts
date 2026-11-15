/**
 * #2191 — one rule for where a product's code provides what changes downstream,
 * shared by the assessment page's deep dive (`ui/src/lib/portfolio-impact.ts`)
 * and the Markdown export (`server/src/lib/portfolio/assessment-markdown.ts`),
 * which each kept a copy and deduplicated differently.
 */
import { describe, expect, it } from "vitest";
import {
  portfolioProviderSites,
  portfolioSiteLocation,
  type PortfolioProviderHop,
} from "./portfolio-assessment.js";

interface Row {
  productId: string;
  coverage: string;
  hops: PortfolioProviderHop[] | null;
}

const hop = (
  fromProductId: string,
  label: string | null,
  sites: Array<{ filePath: string; line: number | null }> | null | undefined,
): PortfolioProviderHop => ({
  fromProductId,
  provider: label === null ? null : { label },
  providerSites: sites,
});

const sites = (rows: Row[], productId: string) =>
  portfolioProviderSites(rows, (r) => r.hops, productId);

describe("portfolioSiteLocation", () => {
  it("names the line when it is known", () => {
    expect(portfolioSiteLocation({ filePath: "src/a.ts", line: 7 })).toBe("src/a.ts:7");
    expect(portfolioSiteLocation({ filePath: "src/a.ts", line: null })).toBe("src/a.ts");
  });
});

describe("portfolioProviderSites", () => {
  it("lists the provider's files of every hop out of the product, each file of each repo once", () => {
    const rows: Row[] = [
      {
        productId: "reporting",
        coverage: "full",
        hops: [hop("orders", "acme/orders", [{ filePath: "src/store.ts", line: null }])],
      },
      {
        productId: "billing",
        coverage: "full",
        hops: [
          // The same file again, downstream of the same table: listed once.
          hop("orders", "acme/orders", [
            { filePath: "src/store.ts", line: null },
            { filePath: "src/schema.sql", line: 3 },
          ]),
          // The same path in another repo is another file.
          hop("orders", "acme/orders-legacy", [{ filePath: "src/store.ts", line: null }]),
          // A hop out of another product is not this one's.
          hop("billing", "acme/billing", [{ filePath: "src/invoice.ts", line: 1 }]),
        ],
      },
    ];
    expect(sites(rows, "orders")).toEqual([
      { repo: "acme/orders", location: "src/store.ts" },
      { repo: "acme/orders", location: "src/schema.sql:3" },
      { repo: "acme/orders-legacy", location: "src/store.ts" },
    ]);
  });

  it("reads nothing from a restricted product's path, a hop with no provider, or no sites", () => {
    const rows: Row[] = [
      {
        productId: "secret",
        coverage: "restricted",
        hops: [hop("orders", "acme/orders", [{ filePath: "src/hidden.ts", line: 1 }])],
      },
      {
        productId: "reporting",
        coverage: "partial",
        hops: [
          hop("orders", null, [{ filePath: "src/unknown.ts", line: 1 }]),
          hop("orders", "acme/orders", null),
          hop("orders", "acme/orders", undefined),
        ],
      },
      { productId: "none", coverage: "full", hops: null },
    ];
    expect(sites(rows, "orders")).toEqual([]);
  });
});
