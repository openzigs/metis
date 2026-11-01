/**
 * #1625 — the read-time view of a portfolio assessment, with the store and
 * access as doubles. The routes over a real database are in
 * `tests/portfolio-assessment-routes-1625.sqlite.test.ts`.
 */
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
const store = vi.hoisted(() => ({ getPortfolioAssessment: vi.fn() }));
vi.mock("./assessment-store.js", () => store);

const {
  renderPortfolioAssessmentMarkdown,
  resolveReaderAccess,
  toListItem,
  viewPortfolioAssessment,
} = await import("./assessment-view.js");

const USER: AuthPayload = {
  userId: "reader",
  username: "reader",
  role: "coordinator",
  permissions: [],
  workspaces: [],
};
const ADMIN: AuthPayload = { ...USER, userId: "root", role: "admin" };

const detail = (repos: Array<{ id: string; label: string; criteria: string[] }>) => ({
  reason: null,
  criteria: [
    {
      criterion: "c1",
      coveredBy: repos.filter((r) => r.criteria[0] === "implemented").map((r) => r.id),
    },
    {
      criterion: "c2",
      coveredBy: repos.filter((r) => r.criteria[1] === "implemented").map((r) => r.id),
    },
  ],
  repos: repos.map((r) => ({
    repoConnectionId: r.id,
    label: r.label,
    verdict: r.criteria.every((c) => c === "implemented") ? "implemented" : "gap-confirmed",
    criteria: r.criteria,
    reason: null,
    costUsd: 0.01,
  })),
  inaccessibleRepoCount: 0,
  costUsd: 0.02,
});

function assessment(overrides: Partial<PortfolioAssessment> = {}): PortfolioAssessment {
  return {
    id: "pa-1",
    statement: "Reset <script>x</script>",
    sourceRequirementId: null,
    sourceProjectId: null,
    scope: "all-accessible",
    productIds: ["p1", "p2"],
    status: "completed",
    portfolioVerdict: "covers",
    summary: "Implemented by One (acme/one-api).",
    report: null,
    costUsd: 0.02,
    createdById: "starter",
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    products: [
      {
        productId: "p1",
        coverage: "covers",
        impactKind: "none",
        via: null,
        edgeIds: [],
        severity: null,
        baSummary: "Covers it: One (acme/one-api).",
        technicalDetail: detail([
          { id: "rc-api", label: "acme/one-api", criteria: ["implemented", "implemented"] },
          { id: "rc-web", label: "acme/one-web", criteria: ["gap-confirmed", "gap-confirmed"] },
        ]),
      },
      {
        productId: "p2",
        coverage: "not-covered",
        impactKind: "none",
        via: null,
        edgeIds: [],
        severity: null,
        baSummary: "Does not cover it | at all.",
        technicalDetail: detail([
          { id: "rc-two", label: "acme/two", criteria: ["gap-confirmed", "gap-confirmed"] },
        ]),
      },
    ],
    repos: [
      {
        productId: "p1",
        repoConnectionId: "rc-api",
        verdict: "implemented",
        citations: [{ filePath: "src/a.ts", startLine: 1, endLine: 1 }],
      },
      { productId: "p1", repoConnectionId: "rc-web", verdict: "gap-confirmed", citations: [] },
      { productId: "p2", repoConnectionId: "rc-two", verdict: "gap-confirmed", citations: [] },
    ],
    ...overrides,
  };
}

let readableProjects: Set<string>;

beforeEach(() => {
  vi.clearAllMocks();
  readableProjects = new Set(["proj-api", "proj-web", "proj-two"]);
  access.buildProductAccessWhere.mockResolvedValue({});
  db.product.findMany.mockResolvedValue([
    { id: "p1", name: "One" },
    { id: "p2", name: "Two" },
  ]);
  access.productRepoReadAccess.mockResolvedValue((r: { repoConnection: { projectId: string } }) =>
    readableProjects.has(r.repoConnection.projectId),
  );
  db.repoConnection.findMany.mockResolvedValue([
    { id: "rc-api", projectId: "proj-api" },
    { id: "rc-web", projectId: "proj-web" },
    { id: "rc-two", projectId: "proj-two" },
  ]);
  discussions.canAccessProjectDiscussions.mockResolvedValue(true);
  store.getPortfolioAssessment.mockResolvedValue(assessment());
});

async function view(user: AuthPayload = USER) {
  return viewPortfolioAssessment(await resolveReaderAccess(user), "pa-1");
}

describe("viewPortfolioAssessment", () => {
  it("a reader who sees everything gets the stored verdict and summary", async () => {
    const v = (await view())!;
    expect(v.verdict).toBe("implemented");
    expect(v.summary).toBe("Implemented by One (acme/one-api).");
    expect(v.products).toEqual(assessment().products);
    expect(v.productNames).toEqual({ p1: "One", p2: "Two" });
  });

  it("a repo hidden now drops its citations and recomputes its product, never to not-covered", async () => {
    readableProjects.delete("proj-api");
    const v = (await view())!;
    const p1 = v.products.find((p) => p.productId === "p1")!;
    expect(p1.coverage).toBe("not-checked");
    expect(p1.technicalDetail).toEqual(
      expect.objectContaining({
        reason: "repos-restricted",
        inaccessibleRepoCount: 1,
        criteria: [
          { criterion: "c1", coveredBy: [] },
          { criterion: "c2", coveredBy: [] },
        ],
      }),
    );
    expect(JSON.stringify(v)).not.toContain("rc-api");
    expect(JSON.stringify(v)).not.toContain("one-api");
    expect(v.repos.map((r) => r.repoConnectionId)).toEqual(["rc-web", "rc-two"]);
    expect(v.verdict).toBe("could-not-verify");
    expect(v.summary).toBe("Could not verify across the portfolio: of 2 products, 1 not checked.");
  });

  it("a detail it cannot read in part is shown as not checked, with nothing of it but why", async () => {
    readableProjects.delete("proj-web");
    const a = assessment();
    a.products[0].technicalDetail = { unexpected: true };
    store.getPortfolioAssessment.mockResolvedValue(a);
    const v = (await view())!;
    // #1673 — the row carries the reason the roll-up uses, so the page can say it.
    expect(v.products[0]).toEqual(
      expect.objectContaining({
        coverage: "not-checked",
        baSummary: "",
        technicalDetail: { reason: "repos-restricted" },
      }),
    );
    expect(v.verdict).toBe("could-not-verify");
  });

  it("a deleted connection is hidden like an unreadable one", async () => {
    db.repoConnection.findMany.mockResolvedValue([
      { id: "rc-web", projectId: "proj-web" },
      { id: "rc-two", projectId: "proj-two" },
    ]);
    const v = (await view())!;
    expect(v.repos.map((r) => r.repoConnectionId)).toEqual(["rc-web", "rc-two"]);
  });

  it("an admin sees everything without a repo lookup, or a listing of every product (#1657)", async () => {
    const v = (await view(ADMIN))!;
    expect(db.repoConnection.findMany).not.toHaveBeenCalled();
    expect(v.products.map((p) => p.coverage)).toEqual(["covers", "not-covered"]);
    // One product read: the names of this assessment's own products.
    expect(db.product.findMany).toHaveBeenCalledTimes(1);
    expect(db.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["p1", "p2"] } } }),
    );
    expect(access.buildProductAccessWhere).not.toHaveBeenCalled();
    expect(v.productNames).toEqual({ p1: "One", p2: "Two" });
  });

  it("the cost is recomputed from what the reader sees when they see less (#1657)", async () => {
    store.getPortfolioAssessment.mockResolvedValue(assessment({ costUsd: 0.05 }));
    expect((await view())!.costUsd).toBe(0.05);
    readableProjects.delete("proj-api");
    // rc-api's call is hidden: only rc-web's and rc-two's remain.
    expect((await view())!.costUsd).toBeCloseTo(0.02, 10);
  });

  it("a restricted row does not make a reader of that product one of its readers (#1657)", async () => {
    // The starter could not read p2: the run stored it restricted.
    const a = assessment();
    a.products[1] = {
      ...a.products[1],
      coverage: "restricted",
      baSummary: "",
      technicalDetail: {},
    };
    a.repos = a.repos.filter((r) => r.productId !== "p2");
    store.getPortfolioAssessment.mockResolvedValue(a);
    db.product.findMany.mockResolvedValue([{ id: "p2", name: "Two" }]);
    expect(await view()).toBeNull();
    // A reader of p1, which the run could read, still reads it.
    db.product.findMany.mockResolvedValue([{ id: "p1", name: "One" }]);
    expect(await view()).not.toBeNull();
  });

  it("an assessment with no product rows yet is its starter's alone (#1657)", async () => {
    store.getPortfolioAssessment.mockResolvedValue(
      assessment({ status: "pending", portfolioVerdict: null, products: [], repos: [] }),
    );
    // `productIds` names p1 and p2, which this reader can read: not enough.
    expect(await view()).toBeNull();
  });

  it("an unreadable source project closes the assessment, even to its starter", async () => {
    store.getPortfolioAssessment.mockResolvedValue(
      assessment({ sourceProjectId: "proj-src", createdById: "reader" }),
    );
    discussions.canAccessProjectDiscussions.mockResolvedValue(false);
    expect(await view()).toBeNull();
    // Memoized per reader: one project check however many reads.
    const acc = await resolveReaderAccess(USER);
    await viewPortfolioAssessment(acc, "pa-1");
    await viewPortfolioAssessment(acc, "pa-1");
    expect(discussions.canAccessProjectDiscussions).toHaveBeenCalledTimes(2);
  });

  it("its starter reads it with no readable product; anyone else does not", async () => {
    db.product.findMany.mockResolvedValue([]);
    expect(await view()).toBeNull();
    store.getPortfolioAssessment.mockResolvedValue(assessment({ createdById: "reader" }));
    const v = (await view())!;
    expect(v.products.map((p) => p.coverage)).toEqual(["restricted", "restricted"]);
    expect(v.repos).toEqual([]);
  });

  it("a run not yet complete keeps a null verdict", async () => {
    store.getPortfolioAssessment.mockResolvedValue(
      assessment({
        status: "running",
        portfolioVerdict: null,
        products: [],
        repos: [],
        createdById: "reader",
      }),
    );
    const v = (await view())!;
    expect(v.verdict).toBeNull();
    expect(v.portfolioVerdict).toBeNull();
    expect(toListItem(v)).toEqual(expect.objectContaining({ status: "running", productCount: 2 }));
  });

  it("a missing assessment is null", async () => {
    store.getPortfolioAssessment.mockResolvedValue(null);
    expect(await view()).toBeNull();
  });
});

describe("viewPortfolioAssessment — impact (#1623)", () => {
  const hop = (provider: string, consumer: string, toProductId: string) => ({
    edgeIds: [`e-${consumer}`],
    edgeProductId: "p1",
    fromProductId: "p1",
    toProductId,
    provider: { repoConnectionId: provider, label: provider },
    consumer: { repoConnectionId: consumer, label: consumer },
    severity: { severity: "low" },
  });
  const impact = (hops: unknown[]) => ({ maxDepth: 2, severity: "low", hops });

  /** p1 changes; p2 is downstream through rc-two; p3 is downstream outside the scope. */
  function withImpactRows(): PortfolioAssessment {
    const a = assessment();
    a.products[0] = { ...a.products[0], impactKind: "direct-change" };
    a.products[1] = {
      ...a.products[1],
      impactKind: "downstream-consumer",
      via: "api",
      edgeIds: ["e-rc-two"],
      severity: "low",
      technicalDetail: {
        ...a.products[1].technicalDetail,
        impact: impact([hop("rc-api", "rc-two", "p2")]),
      },
    };
    a.products.push({
      productId: "p3",
      coverage: "not-checked",
      impactKind: "downstream-consumer",
      via: "database",
      edgeIds: ["e-rc-three"],
      severity: "high",
      baSummary: "Downstream consumer via database (high).",
      technicalDetail: { outOfScope: true, impact: impact([hop("rc-api", "rc-three", "p3")]) },
    });
    return a;
  }

  beforeEach(() => {
    store.getPortfolioAssessment.mockResolvedValue(withImpactRows());
    db.product.findMany.mockResolvedValue([
      { id: "p1", name: "One" },
      { id: "p2", name: "Two" },
      { id: "p3", name: "Three" },
    ]);
    db.repoConnection.findMany.mockResolvedValue([
      { id: "rc-api", projectId: "proj-api" },
      { id: "rc-web", projectId: "proj-web" },
      { id: "rc-two", projectId: "proj-two" },
      { id: "rc-three", projectId: "proj-three" },
    ]);
    readableProjects.add("proj-three");
  });

  it("a reader who sees the whole path gets the impact as stored", async () => {
    const v = (await view())!;
    expect(v.products).toEqual(withImpactRows().products);
    // The impact walk's repos are looked up for the reader too.
    expect(db.repoConnection.findMany.mock.calls[0][0].where.id.in).toContain("rc-three");
  });

  it("a path through a repo hidden now is withheld whole, and its impact reads restricted (#1673)", async () => {
    readableProjects.delete("proj-three");
    const v = (await view())!;
    const p3 = v.products.find((p) => p.productId === "p3")!;
    expect(p3).toEqual(
      expect.objectContaining({
        impactKind: "restricted",
        via: null,
        edgeIds: [],
        severity: null,
        technicalDetail: { outOfScope: true, impactWithheld: true },
        // #1668 — its summary restated the withheld path's kind and severity.
        baSummary: "May be reached through a restricted product.",
      }),
    );
    expect(JSON.stringify(v)).not.toContain("rc-three");
    expect(JSON.stringify(v)).not.toContain("via database");
    expect(renderPortfolioAssessmentMarkdown(v)).not.toContain("(high)");
    // p2's path names only repos the reader can read: untouched.
    expect(v.products.find((p) => p.productId === "p2")!.severity).toBe("low");
  });

  it("a scoped row's withheld path keeps its coverage summary, which names no path (#1668)", async () => {
    const a = withImpactRows();
    a.products[1].technicalDetail = {
      ...a.products[1].technicalDetail,
      impact: impact([hop("rc-api", "rc-three", "p2")]),
    };
    store.getPortfolioAssessment.mockResolvedValue(a);
    readableProjects.delete("proj-three");
    const p2 = (await view())!.products.find((p) => p.productId === "p2")!;
    expect(p2.technicalDetail).toEqual(expect.objectContaining({ impactWithheld: true }));
    expect(p2.severity).toBeNull();
    expect(p2.baSummary).toBe("Does not cover it | at all.");
  });

  it("a path through a product the reader cannot read is withheld, and reads restricted (#1673)", async () => {
    db.product.findMany.mockResolvedValue([
      { id: "p2", name: "Two" },
      { id: "p3", name: "Three" },
    ]);
    const v = (await view())!;
    const p3 = v.products.find((p) => p.productId === "p3")!;
    expect(p3.technicalDetail).toEqual({ outOfScope: true, impactWithheld: true });
    expect(p3.impactKind).toBe("restricted");
    // Two's path starts at p1 too. The overview names both restricted, and says nothing
    // was "not followed": the run walked from p1, which only this reader cannot read.
    expect(v.products.find((p) => p.productId === "p2")!.impactKind).toBe("restricted");
    expect(v.summary).toContain(
      "Restricted: Two, Three may be reached through a restricted product, so their impact is not shown.",
    );
    expect(v.summary).not.toContain("not followed");
  });

  it("a row an earlier run stored none after stopping at a restricted product reads restricted (#1673)", async () => {
    const a = withImpactRows();
    a.products[1] = {
      ...a.products[1],
      impactKind: "none",
      via: null,
      edgeIds: [],
      severity: null,
      technicalDetail: {
        ...a.products[1].technicalDetail,
        impact: { ...impact([]), severity: null, stoppedAtRestricted: 1 },
      },
    };
    a.summary = "Stored summary.";
    store.getPortfolioAssessment.mockResolvedValue(a);
    const v = (await view())!;
    const p2 = v.products.find((p) => p.productId === "p2")!;
    expect(p2.impactKind).toBe("restricted");
    // Only relabelled: it hides nothing the run saw, so the stored summary stands.
    expect(p2.technicalDetail).toEqual(a.products[1].technicalDetail);
    expect(v.summary).toBe("Stored summary.");
    // Without the stop it stays not affected.
    delete (a.products[1].technicalDetail as { impact: Record<string, unknown> }).impact
      .stoppedAtRestricted;
    expect((await view())!.products.find((p) => p.productId === "p2")!.impactKind).toBe("none");
  });

  it("a product the reader cannot read is restricted, keeping only its impact kind", async () => {
    db.product.findMany.mockResolvedValue([
      { id: "p1", name: "One" },
      { id: "p2", name: "Two" },
    ]);
    const v = (await view())!;
    expect(v.products.find((p) => p.productId === "p3")).toEqual({
      productId: "p3",
      coverage: "restricted",
      impactKind: "downstream-consumer",
      via: null,
      edgeIds: [],
      severity: null,
      baSummary: "",
      technicalDetail: {},
    });
  });

  it("a product reached outside the scope never enters the recomputed verdict", async () => {
    // Every scoped product is not covered, and p3 (outside the scope) is restricted now, so
    // the verdict is recomputed. Counted, the restricted p3 would stop the gap.
    const a = withImpactRows();
    a.products[0] = { ...a.products[0], coverage: "not-covered" };
    a.portfolioVerdict = "not-covered";
    store.getPortfolioAssessment.mockResolvedValue(a);
    db.product.findMany.mockResolvedValue([
      { id: "p1", name: "One" },
      { id: "p2", name: "Two" },
    ]);
    const v = (await view())!;
    expect(v.products.find((p) => p.productId === "p3")!.coverage).toBe("restricted");
    expect(v.verdict).toBe("gap-confirmed");
    // #1624 — the recomputed summary carries the impact overview; p3 is counted, not named.
    expect(v.summary).toBe(
      "Nothing in the portfolio covers this.\n\nMust change: One. Downstream: Two (api, low). 1 downstream product is restricted, so it is not named.",
    );
  });

  it("a recomputed verdict leaves out a product with no repos, and names it (#1677)", async () => {
    const a = withImpactRows();
    a.products[0] = { ...a.products[0], coverage: "not-covered" };
    a.portfolioVerdict = "not-covered";
    a.productIds = ["p1", "p2", "p4"];
    a.products.push({
      productId: "p4",
      coverage: "not-checked",
      impactKind: "none",
      via: null,
      edgeIds: [],
      severity: null,
      baSummary: "Not checked (no-repos).",
      technicalDetail: { ...detail([]), reason: "no-repos", costUsd: 0 },
    });
    store.getPortfolioAssessment.mockResolvedValue(a);
    db.product.findMany.mockResolvedValue([
      { id: "p1", name: "One" },
      { id: "p2", name: "Two" },
      { id: "p4", name: "Empty" },
    ]);
    const v = (await view())!;
    expect(v.verdict).toBe("gap-confirmed");
    expect(v.summary).toContain(
      "Nothing in the portfolio covers this. Empty has no repositories to check.",
    );
  });

  it("a list row counts the products in scope, not the rows reached outside it (#1668)", async () => {
    const v = (await view())!;
    expect(v.products).toHaveLength(3);
    expect(toListItem(v).productCount).toBe(2);
  });

  it("a recomputed product whose path is withheld still says so (#1668)", async () => {
    // rc-web (p1's) is hidden now, so p1 is recomputed; its path names rc-three, hidden too.
    readableProjects.delete("proj-web");
    readableProjects.delete("proj-three");
    const a = withImpactRows();
    a.products[0].technicalDetail = {
      ...a.products[0].technicalDetail,
      impact: impact([hop("rc-api", "rc-three", "p3")]),
    };
    store.getPortfolioAssessment.mockResolvedValue(a);
    const p1 = (await view())!.products[0];
    expect(p1.technicalDetail).toEqual(
      expect.objectContaining({ inaccessibleRepoCount: 1, impactWithheld: true }),
    );
    expect(p1.technicalDetail).not.toHaveProperty("impact");
  });

  it("a recomputed product keeps its impact detail", async () => {
    readableProjects.delete("proj-web");
    const v = (await view())!;
    const p1 = v.products.find((p) => p.productId === "p1")!;
    expect(p1.impactKind).toBe("direct-change");
    const a = withImpactRows();
    a.products[0].technicalDetail = {
      ...a.products[0].technicalDetail,
      impact: impact([]),
    };
    store.getPortfolioAssessment.mockResolvedValue(a);
    const again = (await view())!;
    expect(again.products[0].technicalDetail).toEqual(
      expect.objectContaining({ inaccessibleRepoCount: 1, impact: impact([]) }),
    );
  });

  it("reading only a product reached downstream is not enough to read the assessment", async () => {
    db.product.findMany.mockResolvedValue([{ id: "p3", name: "Three" }]);
    expect(await view()).toBeNull();
  });
});

describe("viewPortfolioAssessment — the BA report (#1624)", () => {
  const report = () => ({
    source: "model" as const,
    degraded: false,
    degradedReason: null,
    requirementsSource: "model" as const,
    requirements: [
      {
        text: "Reset by email",
        kind: "functional" as const,
        nfrCategory: null,
        mentions: [] as string[],
      },
    ],
    products: [
      {
        productId: "p1",
        source: "model" as const,
        functional: "One changes.",
        business: "",
        stakeholder: "",
        mentions: ["p1"],
      },
      {
        productId: "p2",
        source: "model" as const,
        functional: "Two follows One.",
        business: "",
        stakeholder: "",
        mentions: ["p1", "p2"],
      },
    ],
    strippedSentences: 0,
    withheld: false,
  });
  const withReport = (over: Partial<PortfolioAssessment> = {}) =>
    assessment({ report: report(), summary: "Model prose about One and Two.", ...over });

  it("a reader who sees what the run saw gets the report and summary as stored", async () => {
    store.getPortfolioAssessment.mockResolvedValue(withReport());
    const v = (await view())!;
    expect(v.report).toEqual(report());
    expect(v.summary).toBe("Model prose about One and Two.");
  });

  it("a reader who sees less gets the deterministic summary, no paragraphs, and the requirements", async () => {
    store.getPortfolioAssessment.mockResolvedValue(withReport());
    readableProjects.delete("proj-api");
    const v = (await view())!;
    expect(v.summary).toBe("Could not verify across the portfolio: of 2 products, 1 not checked.");
    expect(v.report).toEqual({ ...report(), products: [], withheld: true });
  });

  it("an impact path withheld from the reader withholds the prose too", async () => {
    const a = withReport();
    a.products[1] = {
      ...a.products[1],
      impactKind: "downstream-consumer",
      technicalDetail: {
        ...a.products[1].technicalDetail,
        impact: { hops: [{ provider: { repoConnectionId: "rc-hidden" } }] },
      },
    };
    store.getPortfolioAssessment.mockResolvedValue(a);
    const v = (await view())!;
    expect(v.report!.withheld).toBe(true);
    expect(v.report!.products).toEqual([]);
    expect(v.summary).not.toContain("Model prose");
  });

  it("a model requirement naming a product the reader cannot read is dropped", async () => {
    const a = withReport();
    a.report!.requirements.push({
      text: "Nine emails a reset link",
      kind: "functional",
      nfrCategory: null,
      mentions: ["p9"],
    });
    store.getPortfolioAssessment.mockResolvedValue(a);
    expect((await view())!.report!.requirements.map((r) => r.text)).toEqual(["Reset by email"]);
  });

  it("a paragraph naming a product the reader cannot read is dropped (defence in depth)", async () => {
    const a = withReport();
    a.report!.products[1].mentions = ["p2", "p9"];
    store.getPortfolioAssessment.mockResolvedValue(a);
    const v = (await view())!;
    expect(v.report!.products.map((p) => p.productId)).toEqual(["p1"]);
    expect(v.report!.withheld).toBe(false);
  });

  it("a template report a reader sees less of is withheld only when it had paragraphs", async () => {
    const template = { ...report(), source: "template" as const, degraded: true, products: [] };
    store.getPortfolioAssessment.mockResolvedValue(withReport({ report: template }));
    readableProjects.delete("proj-api");
    expect((await view())!.report!.withheld).toBe(false);
  });

  it("no report reads as none", async () => {
    store.getPortfolioAssessment.mockResolvedValue(assessment({ report: null }));
    expect((await view())!.report).toBeNull();
  });
});

describe("renderPortfolioAssessmentMarkdown", () => {
  it("escapes stored text and names repos by label", async () => {
    const md = renderPortfolioAssessmentMarkdown((await view())!);
    expect(md).toContain("Reset &lt;script&gt;x&lt;/script&gt;");
    expect(md).not.toContain("<script>");
    expect(md).toContain("| Two | Does not cover it | Does not cover it \\| at all. |");
    expect(md).toContain("### One: acme/one-api (implemented)");
    expect(md).toContain("- `src/a.ts`");
    expect(md).toContain("**Verdict:** Implemented");
  });

  it("says when there is no verdict yet", async () => {
    store.getPortfolioAssessment.mockResolvedValue(
      assessment({
        status: "pending",
        portfolioVerdict: null,
        products: [],
        repos: [],
        createdById: "reader",
      }),
    );
    expect(renderPortfolioAssessmentMarkdown((await view())!)).toContain(
      "**Verdict:** Not yet assessed",
    );
  });
});
