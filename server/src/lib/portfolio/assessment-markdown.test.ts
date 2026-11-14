/**
 * #1624 — the Markdown export of a portfolio assessment against a committed
 * golden file, rendered from the reader's view (the store and access are
 * doubles). Set `UPDATE_GOLDEN=1` to rewrite the golden after a deliberate
 * change, and review the diff.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPayload, PortfolioAssessment } from "@metis/shared";

const db = vi.hoisted(() => ({
  product: { findMany: vi.fn() },
  repoConnection: { findMany: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
const access = vi.hoisted(() => ({
  buildProductAccessWhere: vi.fn(),
  productRepoReadAccess: vi.fn(),
}));
vi.mock("../products/product-access.js", () => access);
const discussions = vi.hoisted(() => ({ canAccessProjectDiscussions: vi.fn() }));
vi.mock("../discussions/access.js", () => discussions);
const store = vi.hoisted(() => {
  const getPortfolioAssessment = vi.fn();
  return {
    getPortfolioAssessment,
    // #2498 — the view reads the stored record; these fixtures record no source rows.
    getPortfolioAssessmentRecord: async (id: string) => {
      const assessment = await getPortfolioAssessment(id);
      return assessment ? { assessment, sourceRows: null } : null;
    },
  };
});
vi.mock("./assessment-store.js", () => store);

const { resolveReaderAccess, viewPortfolioAssessment } = await import("./assessment-view.js");
const { renderPortfolioAssessmentMarkdown, summaryAfterCoverage } =
  await import("./assessment-markdown.js");

const GOLDEN = fileURLToPath(
  new URL("../../../tests/fixtures/portfolio-report-1624.md.golden", import.meta.url),
);

const READER: AuthPayload = {
  userId: "reader",
  username: "reader",
  role: "coordinator",
  permissions: [],
  workspaces: [],
};

const gapDetail = (repo: { id: string; label: string; verdict: string; criteria: string[] }) => ({
  reason: null,
  criteria: [
    {
      criterion: "A refund posts a ledger entry",
      coveredBy: repo.criteria[0] === "implemented" ? [repo.id] : [],
    },
    { criterion: "It posts within 2 seconds", coveredBy: [] },
  ],
  repos: [
    {
      repoConnectionId: repo.id,
      label: repo.label,
      verdict: repo.verdict,
      criteria: repo.criteria,
      reason: null,
      costUsd: 0.01,
    },
  ],
  inaccessibleRepoCount: 0,
  costUsd: 0.01,
});

const hop = (over: Record<string, unknown>) => ({
  edgeIds: ["e-storefront-orders"],
  edgeProductId: "p-storefront",
  fromProductId: "p-orders",
  toProductId: "p-storefront",
  provider: { repoConnectionId: "rc-orders", label: "acme/orders-api" },
  consumer: { repoConnectionId: "rc-store", label: "acme/storefront" },
  integrationKind: "api",
  strength: "contract",
  direction: "consumes",
  confidence: 0.9,
  origin: "detected",
  resource: null,
  callSites: [{ filePath: "src/checkout/order-client.ts", line: 42 }],
  contract: null,
  sharedObjects: [],
  severity: { severity: "low", strength: "contract", base: "low", modifiers: [] },
  ...over,
});

/** The #1623 fixture's shape: Orders changes; Storefront and Reporting are downstream. */
function fixture(): PortfolioAssessment {
  return {
    id: "pa-1624",
    statement: "Refunds post to the ledger within 2 seconds | <b>fast</b>",
    sourceRequirementId: null,
    sourceProjectId: null,
    sourceDocumentId: null,
    notChecked: [],
    scope: "all-accessible",
    productIds: ["p-orders", "p-reporting", "p-storefront"],
    status: "completed",
    portfolioVerdict: "partial",
    summary: [
      "Partly covered by Orders (acme/orders-api).",
      "Must change: Orders. Downstream: Reporting (database, medium); Storefront (api, medium). 1 downstream product is restricted, so it is not named.",
      "Refunds are only partly delivered today. Orders must change, and Reporting is hit hardest.",
    ].join("\n\n"),
    report: {
      source: "model",
      degraded: false,
      degradedReason: null,
      requirementsSource: "model",
      requirements: [
        {
          text: "A refund posts a ledger entry",
          kind: "functional",
          nfrCategory: null,
          mentions: [],
        },
        {
          text: "Storefront shows the refund status",
          kind: "functional",
          nfrCategory: null,
          mentions: [],
        },
        {
          text: "Posting takes at most 2 seconds",
          kind: "non-functional",
          nfrCategory: "performance",
          mentions: [],
        },
      ],
      products: [
        {
          productId: "p-orders",
          source: "model",
          functional: "Orders posts a ledger entry for every refund.",
          business: "Refunds settle the same day.",
          stakeholder: "Finance reconciles refunds without manual work.",
          mentions: ["p-orders"],
        },
        {
          productId: "p-reporting",
          source: "model",
          functional: "Reporting reads the new ledger rows | twice.",
          business: "",
          stakeholder: "Analysts see refunds in the daily report.",
          mentions: ["p-reporting"],
        },
        {
          productId: "p-storefront",
          source: "template",
          functional: "Storefront depends on Orders through its API; the impact is medium.",
          business: "",
          stakeholder: "",
          mentions: ["p-orders", "p-storefront"],
        },
      ],
      strippedSentences: 1,
      withheld: false,
    },
    hostProductId: null,
    costUsd: 0.05,
    createdById: "reader",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    products: [
      {
        productId: "p-orders",
        coverage: "partial",
        impactKind: "direct-change",
        via: null,
        edgeIds: [],
        severity: null,
        baSummary:
          "Covers part of it: Orders (acme/orders-api). Not found: It posts within 2 seconds.",
        technicalDetail: {
          ...gapDetail({
            id: "rc-orders",
            label: "acme/orders-api",
            verdict: "could-not-verify",
            criteria: ["implemented", "gap-confirmed"],
          }),
          impact: {
            maxDepth: 2,
            severity: null,
            severityRule: "weakest-hop",
            hiddenEdgeCount: 1,
            hops: [],
          },
        },
      },
      {
        productId: "p-partner",
        coverage: "restricted",
        impactKind: "downstream-consumer",
        via: null,
        edgeIds: [],
        severity: null,
        baSummary: "",
        technicalDetail: {},
      },
      {
        productId: "p-reporting",
        coverage: "not-covered",
        impactKind: "downstream-consumer",
        via: "database",
        edgeIds: ["e-orders-reporting"],
        severity: "medium",
        baSummary: "Does not cover it.",
        technicalDetail: {
          ...gapDetail({
            id: "rc-report",
            label: "acme/reporting",
            verdict: "gap-confirmed",
            criteria: ["gap-confirmed", "gap-confirmed"],
          }),
          impact: {
            maxDepth: 2,
            severity: "medium",
            severityRule: "weakest-hop",
            hiddenEdgeCount: 0,
            hops: [
              hop({
                edgeIds: ["e-orders-reporting"],
                edgeProductId: "p-reporting",
                toProductId: "p-reporting",
                consumer: { repoConnectionId: "rc-report", label: "acme/reporting" },
                integrationKind: "database",
                strength: "intrusive",
                direction: "writes",
                confidence: 0.3,
                resource: { kind: "table", name: "orders" },
                callSites: [{ filePath: "sql/daily-report.sql", line: 7 }],
                sharedObjects: [
                  {
                    schemaName: null,
                    objectName: "orders",
                    objectType: "table",
                    usageClass: "used",
                  },
                  {
                    schemaName: "fin",
                    objectName: "ledger",
                    objectType: "column",
                    usageClass: "used",
                  },
                ],
                severity: {
                  severity: "medium",
                  strength: "intrusive",
                  base: "high",
                  modifiers: [{ kind: "low-confidence", step: -1, confidence: 0.3 }],
                },
              }),
            ],
          },
        },
      },
      {
        productId: "p-storefront",
        coverage: "not-covered",
        impactKind: "downstream-consumer",
        via: "api",
        edgeIds: ["e-storefront-orders"],
        severity: "medium",
        baSummary: "Does not cover it.",
        technicalDetail: {
          ...gapDetail({
            id: "rc-store",
            label: "acme/storefront",
            verdict: "gap-confirmed",
            criteria: ["gap-confirmed", "gap-confirmed"],
          }),
          impact: {
            maxDepth: 2,
            severity: "medium",
            severityRule: "weakest-hop",
            hiddenEdgeCount: 0,
            hops: [
              hop({
                contract: {
                  contractDocId: "cdoc-2",
                  repoConnectionId: "rc-orders",
                  version: 2,
                  breaking: true,
                  items: [
                    { id: "graphql type Order", change: "changed", breaking: true },
                    { id: "openapi endpoint GET /refunds", change: "added", breaking: false },
                  ],
                },
                severity: {
                  severity: "medium",
                  strength: "contract",
                  base: "low",
                  modifiers: [
                    { kind: "breaking-contract", step: 1, basis: "latest-contract-version" },
                  ],
                },
              }),
            ],
          },
        },
      },
      {
        productId: "p-topics",
        coverage: "not-checked",
        impactKind: "downstream-consumer",
        via: "event",
        edgeIds: ["e-orders-topic"],
        severity: "low",
        baSummary: "Downstream consumer via event (low).",
        technicalDetail: {
          outOfScope: true,
          impact: {
            maxDepth: 2,
            severity: "low",
            severityRule: "weakest-hop",
            hiddenEdgeCount: 0,
            hops: [
              hop({
                edgeIds: ["e-orders-topic"],
                toProductId: "p-topics",
                consumer: { repoConnectionId: "rc-notify", label: "acme/notifier" },
                integrationKind: "event",
                resource: { kind: "topic", name: "refund.posted" },
                callSites: [{ filePath: "src/listen.ts", line: null }],
              }),
            ],
          },
        },
      },
    ],
    repos: [
      {
        productId: "p-orders",
        repoConnectionId: "rc-orders",
        verdict: "could-not-verify",
        citations: [
          {
            filePath: "src/refunds/post.ts",
            startLine: 1,
            endLine: 1,
            repoConnectionId: "rc-orders",
          },
        ],
      },
      {
        productId: "p-reporting",
        repoConnectionId: "rc-report",
        verdict: "gap-confirmed",
        citations: [],
      },
      {
        productId: "p-storefront",
        repoConnectionId: "rc-store",
        verdict: "gap-confirmed",
        citations: [],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  access.buildProductAccessWhere.mockResolvedValue({});
  access.productRepoReadAccess.mockResolvedValue(() => true);
  discussions.canAccessProjectDiscussions.mockResolvedValue(true);
  db.product.findMany.mockResolvedValue([
    { id: "p-orders", name: "Orders" },
    { id: "p-reporting", name: "Reporting" },
    { id: "p-storefront", name: "Storefront" },
    { id: "p-topics", name: "Notifications" },
  ]);
  db.repoConnection.findMany.mockResolvedValue(
    ["rc-orders", "rc-report", "rc-store", "rc-notify"].map((id) => ({ id, projectId: "proj" })),
  );
  store.getPortfolioAssessment.mockResolvedValue(fixture());
});

async function exported(): Promise<string> {
  const view = await viewPortfolioAssessment(await resolveReaderAccess(READER), "pa-1624");
  return renderPortfolioAssessmentMarkdown(view!);
}

describe("renderPortfolioAssessmentMarkdown (#1624)", () => {
  it("matches the committed golden file", async () => {
    const md = await exported();
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, md);
    expect(md).toBe(readFileSync(GOLDEN, "utf-8"));
  });

  it("a restricted product appears as restricted, with no detail", async () => {
    const md = await exported();
    expect(md).toContain("| p-partner | Restricted |  |  |  |");
    expect(md).toContain(
      "### p-partner\n\nRestricted: you cannot read this product, so nothing about it is shown.",
    );
    const section = md.slice(md.indexOf("### p-partner"));
    expect(section.slice(0, section.indexOf("\n###"))).not.toMatch(/Coverage|Repos|Files|Edge/);
  });

  it("puts the BA summary first and escapes everything stored", async () => {
    const md = await exported();
    expect(md.indexOf("## Summary")).toBeLessThan(md.indexOf("## Products"));
    expect(md.indexOf("## Products")).toBeLessThan(md.indexOf("## Technical deep dive"));
    expect(md).not.toContain("<b>");
    expect(md).toContain("Reporting reads the new ledger rows | twice.");
    // #1749 — the Summary column no longer repeats the Coverage column.
    expect(md).toContain(
      "| Covers part of it | Orders (acme/orders-api). Not found: It posts within 2 seconds. |",
    );
    expect(md).not.toMatch(/\| Does not cover it \| Does not cover it\. \|/);
    // A stored paragraph is escaped too, whoever wrote it.
    const a = fixture();
    a.report!.products[0].business = "<img src=x onerror=alert(1)> wins";
    store.getPortfolioAssessment.mockResolvedValue(a);
    const again = await exported();
    expect(again).toContain("- **Business impact:** &lt;img src=x onerror=alert(1)&gt; wins");
    expect(again).not.toContain("<img");
  });

  it("says when the summary is the degraded template", async () => {
    const a = fixture();
    a.report = {
      ...a.report!,
      source: "template",
      degraded: true,
      degradedReason: "model-offline",
    };
    store.getPortfolioAssessment.mockResolvedValue(a);
    expect(await exported()).toContain(
      "_Degraded: the model is offline, so this is the deterministic template. Business and stakeholder impact were not assessed._",
    );
    a.report = { ...a.report!, degradedReason: "something-new" };
    expect(await exported()).toContain("_Degraded: the model could not write this summary,");
  });

  it("a product the change may reach only through a restricted one reads Restricted (#1668, #1673)", async () => {
    const a = fixture();
    a.products.push({
      productId: "p-ledger",
      coverage: "not-covered",
      impactKind: "restricted",
      via: null,
      edgeIds: [],
      severity: null,
      baSummary: "Does not cover it.",
      technicalDetail: {
        ...gapDetail({
          id: "rc-ledger",
          label: "acme/ledger",
          verdict: "gap-confirmed",
          criteria: ["gap-confirmed", "gap-confirmed"],
        }),
        impact: {
          maxDepth: 2,
          severity: null,
          severityRule: "weakest-hop",
          hiddenEdgeCount: 0,
          stoppedAtRestricted: 1,
          restrictedRule: "walk",
          hops: [],
        },
      },
    });
    store.getPortfolioAssessment.mockResolvedValue(a);
    db.product.findMany.mockResolvedValue([
      { id: "p-orders", name: "Orders" },
      { id: "p-ledger", name: "Ledger" },
    ]);
    const md = await exported();
    const row = md.split("\n").find((l) => l.startsWith("| Ledger |"));
    expect(row).toContain("| Restricted |");
    expect(md).not.toContain("Not reached");
    // Its deep dive says why, without a path.
    const dive = md.slice(md.indexOf("### Ledger"));
    expect(dive).toContain("**Impact:** Restricted");
    expect(dive).toContain(
      "_The change may reach it through a repository or product that the person who ran the check cannot read, so the check could not follow it there, and whether the change reaches this one is not known._",
    );
    expect(dive).not.toContain("**Edge path**");
    const ledgerImpact = (a.products.at(-1)!.technicalDetail as { impact: Record<string, unknown> })
      .impact;

    // #1689 — stored under the older connection rule (#1680, #1685): it claims a
    // connection, not a path, and asks for a re-run.
    ledgerImpact.restrictedRule = "adjacent";
    const adjacent = await exported();
    const adjacentDive = adjacent.slice(adjacent.indexOf("### Ledger"));
    expect(adjacentDive).toContain(
      "_The check stopped at a product the person who ran it cannot read, and this one is connected to it, so whether the change reaches this one is not known. The check ran under an older rule for such connections: run it again for a more exact answer._",
    );
    expect(adjacent).not.toContain("may reach it through");

    // #1685 — stored before #1680 (no rule): the run relabelled it whatever its
    // connection, so the note claims none.
    const legacy = a.products.at(-1)!;
    const stoppedNote =
      "_The check stopped at a product the person who ran it cannot read, so whether the change reaches this one is not known. The check ran before METIS looked for a connection to that product: run it again to find out whether there is one._";
    delete (legacy.technicalDetail as { impact: Record<string, unknown> }).impact.restrictedRule;
    const old = await exported();
    expect(old.slice(old.indexOf("### Ledger"))).toContain(stoppedNote);
    expect(old).not.toContain("may reach it through");

    // An earlier run stored it `none` with the stop: it reads the same (the view relabels it).
    legacy.impactKind = "none";
    const relabelled = await exported();
    expect(relabelled.split("\n").find((l) => l.startsWith("| Ledger |"))).toContain(
      "| Restricted |",
    );
    expect(relabelled.slice(relabelled.indexOf("### Ledger"))).toContain(stoppedNote);
    // Without the stop, `none` is stated plainly.
    delete (legacy.technicalDetail as { impact: Record<string, unknown> }).impact
      .stoppedAtRestricted;
    const plainMd = await exported();
    const plain = plainMd.split("\n").find((l) => l.startsWith("| Ledger |"));
    expect(plain).toContain("| Not affected |");
    // #1689 — a `none` stored under an older rule stays not affected, with a hint
    // to run the check again; one stored under the current rule gets none.
    const olderHint =
      "_This check ran under an older rule for products it could not follow, so a product listed as not affected may still be reached through a repository or product that the person who ran it cannot read. Run the check again to find out._";
    // #1695 — no rule and no stop: a run before #1692 that stopped nowhere, and so
    // never looked past a repo or an edge its starter could not read.
    expect(plainMd).toContain(olderHint);

    Object.assign(ledgerImpact, { stoppedAtRestricted: 1, restrictedRule: "adjacent" });
    const older = await exported();
    expect(older.split("\n").find((l) => l.startsWith("| Ledger |"))).toContain("| Not affected |");
    expect(older).toContain(olderHint);
    ledgerImpact.restrictedRule = "walk";
    const current = await exported();
    expect(current.split("\n").find((l) => l.startsWith("| Ledger |"))).toContain(
      "| Not affected |",
    );
    expect(current).not.toContain(olderHint);
  });

  it("an assessment with no report has no requirement sections", async () => {
    store.getPortfolioAssessment.mockResolvedValue({ ...fixture(), report: null });
    const md = await exported();
    expect(md).not.toContain("## Functional requirements");
    expect(md).not.toContain("### Affected products");
  });

  it("says when there are no requirements of a kind, or they are only the criteria", async () => {
    const a = fixture();
    a.report = { ...a.report!, requirementsSource: "template", requirements: [] };
    store.getPortfolioAssessment.mockResolvedValue(a);
    const md = await exported();
    expect(md).toContain(
      "_The model gave no restatement, so these are the assessment's criteria._",
    );
    expect(md).toContain("## Non-functional requirements\n\n_None identified._");
  });

  it("#2183 — a host's deep dive lists where it provides what changes, and every linked table", async () => {
    const a = fixture();
    // A gap-confirmed host: the gap engine cited nothing in it.
    a.repos = a.repos.map((r) => (r.productId === "p-orders" ? { ...r, citations: [] } : r));
    const reporting = a.products.find((p) => p.productId === "p-reporting")!;
    const impact = (reporting.technicalDetail as { impact: Record<string, unknown> }).impact;
    const [dbHop] = impact.hops as Array<Record<string, unknown>>;
    dbHop.providerSites = [{ filePath: "src/orders/store.ts", line: 12 }];
    impact.links = [
      {
        integrationKind: "database",
        fromProductId: "p-orders",
        edgeProductIds: ["p-reporting"],
        providerRepoId: "rc-orders",
        consumerRepoId: "rc-report",
        resources: [
          { kind: "table", name: "orders" },
          { kind: "table", name: "customers" },
        ],
      },
    ];
    const store1 = a.products.find((p) => p.productId === "p-storefront")!;
    const [apiHop] = (
      store1.technicalDetail as { impact: { hops: Array<Record<string, unknown>> } }
    ).impact.hops;
    // The same file twice (two downstream products) is listed once; a line-less site as the file.
    apiHop.providerSites = [
      { filePath: "schema.graphql", line: null },
      { filePath: "src/orders/store.ts", line: 12 },
    ];
    store.getPortfolioAssessment.mockResolvedValue(a);
    const md = await exported();
    const section = (heading: string) => {
      const s = md.slice(md.indexOf(`### ${heading}\n`));
      return s.slice(0, s.indexOf("\n### ", 1));
    };
    const orders = section("Orders");
    expect(orders).toContain(
      "**Files**\n\n- `src/orders/store.ts:12` (acme/orders-api): provides what changes\n- `schema.graphql` (acme/orders-api): provides what changes\n",
    );
    expect(orders.match(/src\/orders\/store\.ts/g)).toHaveLength(1);
    // Reporting, reached through `orders`, also lists `customers` from its link.
    const rep = section("Reporting");
    expect(rep).toContain("- `customers`");
    expect(rep).not.toContain("provides what changes");
  });

  it("#2272 — lists each requirement checked and everything not checked, escaped", async () => {
    store.getPortfolioAssessment.mockResolvedValue({
      ...fixture(),
      notChecked: [
        { text: "Refunds <b>over</b> 1k | escalate", reason: "over-limit", count: null },
        { text: "Appendix B", reason: "section-unread", count: null },
      ],
    });
    const md = await exported();
    const notChecked = md.slice(md.indexOf("## Not checked"));
    expect(notChecked).toContain(
      "- Refunds &lt;b&gt;over&lt;/b&gt; 1k | escalate: Not checked: one check takes 100 requirements, and this one is past them.",
    );
    expect(notChecked).toContain(
      "- Appendix B: Not checked: the model could not read this section of the document.",
    );
    // After the summary's affected products, before the restated requirements.
    expect(md.indexOf("## Requirements checked")).toBeGreaterThan(
      md.indexOf("### Affected products"),
    );
    expect(md.indexOf("## Not checked")).toBeLessThan(md.indexOf("## Functional requirements"));
    expect(md).toContain("| 1 | A refund posts a ledger entry | Orders |");
    expect(md).toContain("| 2 | It posts within 2 seconds | No product found |");
  });

  it("#2272 — a check of one requirement whole, with nothing cut, adds neither section", async () => {
    const one = fixture();
    store.getPortfolioAssessment.mockResolvedValue({
      ...one,
      products: one.products.map((p) =>
        p.productId === "p-orders"
          ? {
              ...p,
              technicalDetail: {
                ...p.technicalDetail,
                criteria: [{ criterion: "Refunds post", coveredBy: ["rc-orders"] }],
              },
            }
          : { ...p, technicalDetail: { ...p.technicalDetail, criteria: undefined } },
      ),
    });
    const md = await exported();
    expect(md).not.toContain("## Requirements checked");
    expect(md).not.toContain("## Not checked");
  });
});

describe("summaryAfterCoverage (#1749)", () => {
  it("leaves the cell empty when the summary is only its coverage", () => {
    expect(summaryAfterCoverage("Does not cover it.", "Does not cover it")).toBe("");
    expect(summaryAfterCoverage("  Does not cover it  ", "Does not cover it")).toBe("");
  });

  it("keeps what the summary adds after its coverage", () => {
    expect(summaryAfterCoverage("Covers it: Orders (acme/orders-api).", "Covers it")).toBe(
      "Orders (acme/orders-api).",
    );
    expect(
      summaryAfterCoverage("Not checked. the model call failed for one repo.", "Not checked"),
    ).toBe("The model call failed for one repo.");
  });

  it("reads a bare reason in brackets as the reason", () => {
    expect(summaryAfterCoverage("Not checked (could-not-verify).", "Not checked")).toBe(
      "Reason: could-not-verify.",
    );
  });

  it("keeps a summary about something else whole", () => {
    expect(summaryAfterCoverage("Downstream consumer via event (low).", "Does not cover it")).toBe(
      "Downstream consumer via event (low).",
    );
    expect(summaryAfterCoverage("", "Covers it")).toBe("");
  });
});
