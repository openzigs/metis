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

  it("a detail it cannot read in part is shown as not checked, with nothing of it", async () => {
    readableProjects.delete("proj-web");
    const a = assessment();
    a.products[0].technicalDetail = { unexpected: true };
    store.getPortfolioAssessment.mockResolvedValue(a);
    const v = (await view())!;
    expect(v.products[0]).toEqual(
      expect.objectContaining({ coverage: "not-checked", baSummary: "", technicalDetail: {} }),
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

  it("an admin sees everything without a repo lookup", async () => {
    db.product.findMany.mockResolvedValue([]);
    const v = (await view(ADMIN))!;
    expect(db.repoConnection.findMany).not.toHaveBeenCalled();
    expect(v.products.map((p) => p.coverage)).toEqual(["covers", "not-covered"]);
    expect(v.productNames).toEqual({});
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
      assessment({ status: "running", portfolioVerdict: null, products: [], repos: [] }),
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
      assessment({ status: "pending", portfolioVerdict: null, products: [], repos: [] }),
    );
    expect(renderPortfolioAssessmentMarkdown((await view())!)).toContain(
      "**Verdict:** Not yet assessed",
    );
  });
});
