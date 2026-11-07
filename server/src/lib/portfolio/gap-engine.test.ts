/**
 * #1622 — the gap engine's edge paths, with the database and product access
 * as doubles. The end-to-end behaviour over a real database is in
 * `tests/portfolio-gap-engine-1622.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPayload } from "@metis/shared";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import type { FederatedSearchResult } from "../rag/federated-search-service.js";

const db = vi.hoisted(() => ({
  product: { findMany: vi.fn() },
  productRepo: { findMany: vi.fn() },
  requirement: { findFirst: vi.fn() },
}));
const discussions = vi.hoisted(() => ({ canAccessProjectDiscussions: vi.fn() }));
vi.mock("../discussions/access.js", () => discussions);
// `Prisma` stays real: assessment-store sizes its batches from the generated
// client's scalar-field enums (#1647).
vi.mock("../prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../prisma.js")>()),
  prisma: db,
}));

const access = vi.hoisted(() => ({
  assertProductAccessible: vi.fn(),
  buildProductAccessWhere: vi.fn(),
  productRepoReadAccess: vi.fn(),
}));
vi.mock("../products/product-access.js", () => access);

const defaults = vi.hoisted(() => ({
  buildProvider: vi.fn(),
  searchAcrossProjects: vi.fn(),
}));
vi.mock("../ai/providers/factory.js", () => ({ buildProvider: defaults.buildProvider }));
vi.mock("../rag/federated-search-service.js", () => ({
  getFederatedSearchService: () => ({ searchAcrossProjects: defaults.searchAcrossProjects }),
}));

const {
  evaluatePortfolioGap,
  mapWithConcurrency,
  portfolioGapInputSchema,
  portfolioSummary,
  querySearchedFor,
  readPortfolioGapLimits,
  runPortfolioGapAnalysis,
  scopedToChange,
  toAssessmentInput,
} = await import("./gap-engine.js");
const { AppError } = await import("../../middleware/error-handler.js");

const USER: AuthPayload = {
  userId: "u",
  username: "u",
  role: "coordinator",
  permissions: [],
  workspaces: [],
};

function reply(content: string): ChatResponse {
  return {
    content,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "m",
    provider: "openai",
  };
}

function provider(answer: (prompt: string) => string | Promise<string>): AIProvider {
  return {
    key: "openai",
    model: "m",
    offline: false,
    chat: vi.fn(async (messages: Array<{ role: string; content: unknown }>) =>
      reply(await answer(String(messages[1].content))),
    ),
  } as unknown as AIProvider;
}

const hit = (repo: string, path: string | undefined, text: string) => ({
  chunkId: `${repo}:${path}`,
  projectId: "proj",
  projectName: "proj",
  documentId: "d",
  filename: path ? `connector:repo:${repo}:src/${path}` : "README.md",
  ...(path ? { path } : {}),
  position: 0,
  text,
  score: 1,
});

const found = (hits: ReturnType<typeof hit>[]): FederatedSearchResult => ({
  hits,
  projectsSearched: ["proj"],
  projectsFailed: [],
  totalHits: hits.length,
});

const ALL = { scope: "all-accessible" as const };
const limits = { runCostCapUsd: 10, productCostCapUsd: 10, concurrency: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  access.buildProductAccessWhere.mockResolvedValue({});
  access.productRepoReadAccess.mockResolvedValue(() => true);
  access.assertProductAccessible.mockResolvedValue(undefined);
  db.product.findMany.mockResolvedValue([
    { id: "p2", name: "Two" },
    { id: "p1", name: "One" },
  ]);
  db.productRepo.findMany.mockImplementation(async ({ where }) =>
    (where.productId.in as string[]).map((productId) => ({
      productId,
      repoConnectionId: `rc-${productId}`,
      repoConnection: {
        projectId: "proj",
        label: `label-${productId}`,
        ownerOrOrg: null,
        repoName: null,
      },
    })),
  );
});

describe("portfolioGapInputSchema", () => {
  it('a "product" scope names exactly one product', () => {
    const parse = (productIds?: string[]) =>
      portfolioGapInputSchema.safeParse({ statement: "s", scope: "product", productIds }).success;
    expect(parse()).toBe(false);
    expect(parse(["p"])).toBe(true);
    expect(parse(["p", "q"])).toBe(false);
  });

  it("refuses an empty statement and an unknown field", () => {
    expect(portfolioGapInputSchema.safeParse({ statement: " ", ...ALL }).success).toBe(false);
    expect(portfolioGapInputSchema.safeParse({ statement: "s", ...ALL, x: 1 }).success).toBe(false);
  });
});

describe("readPortfolioGapLimits", () => {
  it("defaults to $2 per run, $0.50 per product, 4 at once and 250 model calls", () => {
    expect(readPortfolioGapLimits()).toMatchObject({
      runCostCapUsd: 2,
      productCostCapUsd: 0.5,
      concurrency: 4,
      maxModelCalls: 250,
    });
  });
});

describe("querySearchedFor (#1657)", () => {
  it("is true for a criterion the query carries whole, or by two of its terms", () => {
    expect(querySearchedFor("s\nc1", "c1")).toBe(true);
    expect(querySearchedFor("download the invoices in PDF", "Invoices download as a PDF")).toBe(
      true,
    );
    expect(querySearchedFor("download the reports", "Invoices download as a PDF")).toBe(false);
    expect(querySearchedFor("lorem ipsum", "Invoices download as a PDF")).toBe(false);
  });
});

describe("mapWithConcurrency (#1657)", () => {
  it("starts no new item once one has failed", async () => {
    const started: number[] = [];
    const run = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (n) => {
      started.push(n);
      if (n === 0) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 5));
      return n;
    });
    await expect(run).rejects.toThrow("boom");
    // Let the other worker finish the item it had already started.
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toEqual([0, 1]);
  });
});

describe("runPortfolioGapAnalysis source (#1657)", () => {
  const withSource = (extra: object) => ({ statement: "s", ...ALL, ...extra });

  it("404 for a source requirement the starter cannot read, deleted or unknown, before any work", async () => {
    db.requirement.findFirst.mockResolvedValue({
      id: "r1",
      projectId: "proj-x",
      title: "t",
      body: "b",
      acceptanceCriteria: null,
    });
    discussions.canAccessProjectDiscussions.mockResolvedValue(false);
    const p = provider(() => "{}");
    await expect(
      runPortfolioGapAnalysis(
        USER,
        withSource({ sourceRequirementId: "r1", sourceProjectId: "proj-x" }),
        {
          provider: p,
          limits,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    // A soft-deleted one is not found: the read filters on `deletedAt`, and on the project.
    expect(db.requirement.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1", deletedAt: null, projectId: "proj-x" } }),
    );
    db.requirement.findFirst.mockResolvedValue(null);
    await expect(
      runPortfolioGapAnalysis(USER, withSource({ sourceRequirementId: "r1" }), {
        provider: p,
        limits,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(p.chat).not.toHaveBeenCalled();
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it("400 for a source project with no source requirement", async () => {
    await expect(
      runPortfolioGapAnalysis(USER, withSource({ sourceProjectId: "proj-x" }), { limits }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("evaluatePortfolioGap", () => {
  it("falls back to the statement when the decomposition is unusable or fails", async () => {
    for (const answer of [() => "not json", () => '{"criteria": []}']) {
      const result = await evaluatePortfolioGap(
        USER,
        { statement: "Export invoices", ...ALL },
        { provider: provider(answer), search: async () => found([]), limits },
      );
      expect(result.criteria).toEqual(["Export invoices"]);
    }
    const failing = provider(() => {
      throw new Error("provider down");
    });
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "Export invoices", ...ALL },
      { provider: failing, search: async () => found([]), limits },
    );
    expect(result.criteria).toEqual(["Export invoices"]);
  });

  it("spends nothing on decomposition when the run has no budget", async () => {
    const p = provider(() => '{"criteria": ["a"]}');
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", ...ALL },
      { provider: p, search: async () => found([]), limits: { ...limits, runCostCapUsd: 0 } },
    );
    expect(p.chat).not.toHaveBeenCalled();
    expect(result.criteria).toEqual(["s"]);
  });

  it("makes no model call when nothing in scope is readable", async () => {
    access.assertProductAccessible.mockRejectedValue(new AppError(404, "NOT_FOUND", "x"));
    const p = provider(() => '{"criteria": ["a"]}');
    const named = await evaluatePortfolioGap(
      USER,
      { statement: "s", scope: "product", productIds: ["p9"], criteria: ["c1"] },
      { provider: p, search: async () => found([]), limits },
    );
    expect(p.chat).not.toHaveBeenCalled();
    expect(named.criteria).toEqual(["c1"]);
    expect(named.products).toEqual([
      expect.objectContaining({ productId: "p9", coverage: "restricted" }),
    ]);
    expect(named.summary).toBe(
      "Could not verify across the portfolio: of 1 products, 1 restricted.",
    );
    db.product.findMany.mockResolvedValue([]);
    const empty = await evaluatePortfolioGap(
      USER,
      { statement: "s", ...ALL },
      { provider: p, search: async () => found([]), limits },
    );
    expect(empty.products).toEqual([]);
    expect(empty.criteria).toEqual(["s"]);
    expect(empty.summary).toBe("Could not verify: no product was in scope.");
  });

  it("an access error other than not-found is not read as restricted", async () => {
    access.assertProductAccessible.mockRejectedValue(new Error("db down"));
    await expect(
      evaluatePortfolioGap(
        USER,
        { statement: "s", scope: "product", productIds: ["p1"] },
        { provider: provider(() => "{}"), limits },
      ),
    ).rejects.toThrow("db down");
  });

  it("a product with no repo is not checked", async () => {
    db.productRepo.findMany.mockResolvedValue([]);
    const search = vi.fn();
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c"], ...ALL },
      { provider: provider(() => "{}"), search, limits },
    );
    expect(search).not.toHaveBeenCalled();
    expect(result.products.map((p) => [p.productId, p.coverage, p.reason])).toEqual([
      ["p1", "not-checked", "no-repos"],
      ["p2", "not-checked", "no-repos"],
    ]);
  });

  it("a product with no repos does not stop a confirmed gap, and is named (#1677)", async () => {
    db.product.findMany.mockResolvedValue([
      { id: "p1", name: "One" },
      { id: "p3", name: "Empty" },
      { id: "p2", name: "Two" },
    ]);
    const withRepos = db.productRepo.findMany.getMockImplementation()!;
    db.productRepo.findMany.mockImplementation(async (args) =>
      (await withRepos(args)).filter((r: { productId: string }) => r.productId !== "p3"),
    );
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1"], ...ALL },
      {
        provider: provider(() =>
          JSON.stringify({ criteria: [{ index: 1, verdict: "gap-confirmed" }] }),
        ),
        search: async () => found([hit("rc-p1", "a.ts", "a"), hit("rc-p2", "b.ts", "b")]),
        limits,
      },
    );
    expect(result.products.map((p) => [p.productId, p.coverage, p.reason])).toEqual([
      ["p1", "not-covered", null],
      ["p2", "not-covered", null],
      ["p3", "not-checked", "no-repos"],
    ]);
    expect(result.verdict).toBe("gap-confirmed");
    expect(result.summary).toBe(
      "Nothing in the portfolio covers this. Empty has no repositories to check.",
    );
  });

  it("ignores hits that are not repository source, and a criterion the reply omits is unverified", async () => {
    const answers: string[] = [];
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1", "c2"], ...ALL },
      {
        provider: provider((prompt) => {
          answers.push(prompt);
          return JSON.stringify({
            criteria: [{ index: 1, verdict: "implemented", excerpts: [1] }],
          });
        }),
        search: async () =>
          found([
            hit("rc-p1", undefined, "readme"),
            hit("rc-p1", "a.ts", "  "),
            hit("rc-p2", "b.ts", "b"),
          ]),
        limits,
      },
    );
    expect(answers.every((a) => !a.includes("readme"))).toBe(true);
    const p1 = result.products.find((p) => p.productId === "p1")!;
    expect(p1.repos[0].criteria).toEqual(["implemented", "could-not-verify"]);
    // A blank excerpt cites no snippet.
    expect(p1.repos[0].citations).toEqual([
      { filePath: "a.ts", startLine: 1, endLine: 1, repoConnectionId: "rc-p1" },
    ]);
    expect(p1.coverage).toBe("partial");
  });

  it("an implemented claim citing nothing is downgraded by the verdict gate", async () => {
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1"], ...ALL },
      {
        provider: provider(() =>
          JSON.stringify({ criteria: [{ index: 1, verdict: "implemented", excerpts: [] }] }),
        ),
        search: async () => found([hit("rc-p1", "a.ts", "a"), hit("rc-p2", "b.ts", "b")]),
        limits,
      },
    );
    expect(result.products.map((p) => p.coverage)).toEqual(["not-checked", "not-checked"]);
    expect(result.products[0].repos[0].verdict).toBe("could-not-verify");
  });

  it("a portfolio covered only in part reads partial, naming the products", async () => {
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1", "c2"], ...ALL },
      {
        provider: provider(() =>
          JSON.stringify({
            criteria: [
              { index: 1, verdict: "implemented", excerpts: [1] },
              { index: 2, verdict: "gap-confirmed" },
            ],
          }),
        ),
        search: async () => found([hit("rc-p1", "a.ts", "a"), hit("rc-p2", "b.ts", "b")]),
        limits,
      },
    );
    expect(result.verdict).toBe("partial");
    expect(result.summary).toBe("Partly covered by One (label-p1); Two (label-p2).");
  });

  it("judges every supplied criterion, even past the decomposition cap", async () => {
    const criteria = Array.from({ length: 12 }, (_, i) => `c${i + 1}`);
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria, ...ALL },
      {
        provider: provider(() =>
          JSON.stringify({
            criteria: criteria.map((_, i) =>
              i === 11
                ? { index: i + 1, verdict: "gap-confirmed" }
                : { index: i + 1, verdict: "implemented", excerpts: [1] },
            ),
          }),
        ),
        search: async () => found([hit("rc-p1", "a.ts", "a"), hit("rc-p2", "b.ts", "b")]),
        limits,
      },
    );
    expect(result.criteria).toEqual(criteria);
    expect(result.products.every((p) => p.coverage === "partial")).toBe(true);
    expect(result.verdict).toBe("partial");
    expect(
      toAssessmentInput(result, {
        createdById: "u",
        sourceRequirementId: null,
        sourceProjectId: null,
      }).products?.[0]?.baSummary,
    ).toContain("Not found: c12.");
  });

  it("a partial product reports a criterion it could not verify as not checked, not as a gap", async () => {
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1", "c2", "c3"], ...ALL },
      {
        provider: provider(() =>
          JSON.stringify({
            criteria: [
              { index: 1, verdict: "implemented", excerpts: [1] },
              { index: 2, verdict: "gap-confirmed" },
            ],
          }),
        ),
        search: async () => found([hit("rc-p1", "a.ts", "a"), hit("rc-p2", "b.ts", "b")]),
        limits,
      },
    );
    const summary = toAssessmentInput(result, {
      createdById: "u",
      sourceRequirementId: null,
      sourceProjectId: null,
    }).products?.[0]?.baSummary;
    expect(summary).toContain("Not found: c2.");
    expect(summary).toContain("Not checked: c3.");
    expect(summary).not.toContain("Not found: c2; c3");
  });

  it("an abort stops the run instead of reading as a failed repo", async () => {
    const controller = new AbortController();
    const p = provider(() => {
      controller.abort(new Error("cancelled"));
      throw new Error("aborted mid-call");
    });
    await expect(
      evaluatePortfolioGap(
        USER,
        { statement: "s", criteria: ["c1"], ...ALL },
        {
          provider: p,
          search: async () => found([hit("rc-p1", "a.ts", "a"), hit("rc-p2", "b.ts", "b")]),
          limits,
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("cancelled");
  });

  it("the call cap stops new model calls, counting the decomposition (#1657)", async () => {
    const answer = () =>
      JSON.stringify({
        criteria: [{ index: 1, verdict: "implemented", excerpts: [1] }],
      });
    const search = async () => found([hit("rc-p1", "a.ts", "a"), hit("rc-p2", "b.ts", "b")]);
    // Unpriced: the cost caps never bind, the call cap does.
    const capped = provider(answer);
    const one = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1"], ...ALL },
      { provider: capped, search, limits: { ...limits, maxModelCalls: 1 }, costOf: () => 0 },
    );
    expect(capped.chat).toHaveBeenCalledTimes(1);
    expect(one.products.map((p) => p.repos[0].reason)).toEqual([null, "budget"]);
    // The decomposition is a call too: with one allowed, no repo is judged.
    const decomposing = provider(() => '{"criteria": ["c1"]}');
    const none = await evaluatePortfolioGap(
      USER,
      { statement: "s", ...ALL },
      { provider: decomposing, search, limits: { ...limits, maxModelCalls: 1 }, costOf: () => 0 },
    );
    expect(decomposing.chat).toHaveBeenCalledTimes(1);
    expect(none.products.every((p) => p.repos[0].reason === "budget")).toBe(true);
  });

  it("a criterion the query never carried is not a confirmed gap (#1657)", async () => {
    // The query is cut at 4,000 characters, so this criterion never reaches it.
    const statement = "lorem ".repeat(700).trim();
    const result = await evaluatePortfolioGap(
      USER,
      { statement, criteria: ["Invoices are exported as PDF"], ...ALL },
      {
        provider: provider(() =>
          JSON.stringify({ criteria: [{ index: 1, verdict: "gap-confirmed" }] }),
        ),
        search: async () => found([hit("rc-p1", "a.ts", "a"), hit("rc-p2", "b.ts", "b")]),
        limits,
      },
    );
    expect(result.products[0].repos[0].criteria).toEqual(["could-not-verify"]);
    expect(result.products.map((p) => p.coverage)).toEqual(["not-checked", "not-checked"]);
    expect(result.verdict).toBe("could-not-verify");
  });

  it("uses the deployment provider, the federated search and the price table by default", async () => {
    const p = provider(() => '{"criteria": ["c"]}');
    defaults.buildProvider.mockReturnValue(p);
    defaults.searchAcrossProjects.mockResolvedValue(found([]));
    const result = await evaluatePortfolioGap(USER, { statement: "s", ...ALL }, { limits });
    expect(p.chat).toHaveBeenCalledTimes(1);
    expect(defaults.searchAcrossProjects).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u", projectIds: ["proj"], k: 24 }),
    );
    // The scripted model "m" is not in the price table: unpriced reads as 0.
    expect(result.costUsd).toBe(0);
  });
});

describe("#1685 — naming the products with no repos under a confirmed gap", () => {
  const empty = (productId: string, name: string | null) => ({
    productId,
    name,
    coverage: "not-checked" as const,
    reason: "no-repos" as const,
    repos: [],
    criteriaCoveredBy: [],
    inaccessibleRepoCount: 0,
    costUsd: 0,
  });

  it("names the first three, then says how many more", () => {
    const names = ["A", "B", "C", "D", "E"];
    const products = names.map((n) => empty(`p-${n}`, n));
    expect(portfolioSummary("gap-confirmed", products)).toBe(
      "Nothing in the portfolio covers this. A, B, C and 2 more have no repositories to check.",
    );
    expect(portfolioSummary("gap-confirmed", products.slice(0, 4))).toBe(
      "Nothing in the portfolio covers this. A, B, C and 1 more have no repositories to check.",
    );
    // #1689 — three or fewer: the last joined by "and".
    expect(portfolioSummary("gap-confirmed", products.slice(0, 3))).toBe(
      "Nothing in the portfolio covers this. A, B and C have no repositories to check.",
    );
  });

  it("never puts a raw product id into the prose", () => {
    const text = portfolioSummary("gap-confirmed", [empty("p-raw-id", null), empty("p2", "Two")]);
    // #1689 — a nameless product is counted, never named "a product" in a list.
    expect(text).toBe(
      "Nothing in the portfolio covers this. Two and 1 more have no repositories to check.",
    );
    expect(text).not.toContain("p-raw-id");
    expect(portfolioSummary("gap-confirmed", [empty("p1", null), empty("p2", null)])).toBe(
      "Nothing in the portfolio covers this. 2 products have no repositories to check.",
    );
    expect(portfolioSummary("gap-confirmed", [empty("p1", null)])).toBe(
      "Nothing in the portfolio covers this. A product has no repositories to check.",
    );
  });

  it("#1689 — a covering product with no name is 'a product', never its id", () => {
    const covering = {
      ...empty("p-raw-id", null),
      coverage: "covers" as const,
      reason: null,
      repos: [
        {
          productId: "p-raw-id",
          repoConnectionId: "rc",
          label: "acme/pay",
          verdict: "implemented" as const,
          criteria: ["implemented" as const],
          citations: [],
          reason: null,
          costUsd: 0,
        },
      ],
    };
    expect(portfolioSummary("implemented", [covering])).toBe(
      "Implemented by a product (acme/pay).",
    );
  });
});

describe("#1963 — the verdict over the products in scope of the change", () => {
  type Coverage = "not-covered" | "not-checked" | "restricted" | "partial";
  const product = (productId: string, name: string | null, coverage: Coverage) => ({
    productId,
    name,
    coverage,
    reason: coverage === "not-checked" ? ("could-not-verify" as const) : null,
    repos: [],
    criteriaCoveredBy: [],
    inaccessibleRepoCount: 0,
    costUsd: 0,
  });
  /**
   * `edgesDetected` defaults to true: a product analysed, so its `none` had edges
   * to reason over. `connectedToChange` defaults to false for a `none` (no path
   * of edges links it to what changes) and true for anything the walk reached.
   */
  const impactOf = (
    rows: Array<
      [
        string,
        "direct-change" | "downstream-consumer" | "restricted" | "none",
        boolean?,
        boolean?,
        boolean?,
      ]
    >,
  ) => ({
    products: rows.map(
      ([
        productId,
        impactKind,
        restricted = false,
        edgesDetected = true,
        connectedToChange = impactKind !== "none",
      ]) => ({
        productId,
        impactKind,
        restricted,
        edgesDetected,
        connectedToChange,
      }),
    ),
  });
  /** The #1940 live check: the host and its downstream products, and old ones nobody indexed. */
  const products = [
    product("p-commerce", "LC Commerce", "not-covered"),
    product("p-orders", "LC orders", "not-covered"),
    product("p-billing", "LC billing", "not-covered"),
    product("p-notify", "LC notify", "not-covered"),
    product("p-old-1", "Walkthrough 1", "not-checked"),
    product("p-old-2", "Walkthrough 2", "not-checked"),
  ];
  const gapOf = (rows: ReturnType<typeof product>[]) => {
    const verdict = rows.some((p) => p.coverage === "not-checked")
      ? ("could-not-verify" as const)
      : ("gap-confirmed" as const);
    return {
      statement: "S",
      criteria: ["c"],
      scope: "all-accessible" as const,
      productIds: rows.map((p) => p.productId),
      products: rows,
      verdict,
      summary: portfolioSummary(verdict, rows),
      costUsd: 0,
    };
  };
  const issueImpact = impactOf([
    ["p-commerce", "direct-change"],
    ["p-orders", "direct-change"],
    ["p-billing", "downstream-consumer"],
    ["p-notify", "downstream-consumer"],
    ["p-old-1", "none"],
    ["p-old-2", "none"],
  ]);

  it("a gap every product the change touches confirms is a gap; the unrelated ones are named", () => {
    const gap = gapOf(products);
    expect(gap.verdict).toBe("could-not-verify");
    const scoped = scopedToChange(gap, issueImpact);
    expect(scoped.verdict).toBe("gap-confirmed");
    expect(scoped.notInScope).toEqual(["p-old-1", "p-old-2"]);
    expect(scoped.summary).toBe(
      "Nothing checked covers this. Walkthrough 1 and Walkthrough 2 were not checked, but they are not connected to any product this change touches, so they are not in scope.",
    );
    // Stored as the scoped verdict.
    const record = toAssessmentInput(scoped, {
      createdById: "u",
      sourceRequirementId: null,
      sourceProjectId: null,
    });
    expect(record.portfolioVerdict).toBe("not-covered");
    expect(record.summary).toBe(scoped.summary);
  });

  it("a product the change reaches that was not checked still reads could-not-verify, told apart", () => {
    const rows = products.map((p) =>
      p.productId === "p-notify" ? product("p-notify", "LC notify", "not-checked") : p,
    );
    const scoped = scopedToChange(gapOf(rows), issueImpact);
    expect(scoped.verdict).toBe("could-not-verify");
    expect(scoped.summary).toBe(
      "Could not verify across the portfolio: of 4 products in scope, 1 not checked. Walkthrough 1 and Walkthrough 2 were not checked, but they are not connected to any product this change touches, so they are not in scope.",
    );
  });

  it("a product never analysed is not called out of scope: it stays in, and says why", () => {
    // Its edges were never detected, so the walk's `none` for it says nothing.
    const unanalysed = impactOf([
      ["p-commerce", "direct-change"],
      ["p-orders", "direct-change"],
      ["p-billing", "downstream-consumer"],
      ["p-notify", "downstream-consumer"],
      ["p-old-1", "none", false, true],
      ["p-old-2", "none", false, false],
    ]);
    const scoped = scopedToChange(gapOf(products), unanalysed);
    expect(scoped.verdict).toBe("could-not-verify");
    expect(scoped.notInScope).toEqual(["p-old-1"]);
    expect(scoped.neverAnalysed).toEqual(["p-old-2"]);
    expect(scoped.summary).toBe(
      "Could not verify across the portfolio: of 5 products in scope, 1 not checked. Walkthrough 2 was not checked and has never been analysed, so whether this change reaches it is not known. Walkthrough 1 was not checked, but it is not connected to any product this change touches, so it is not in scope.",
    );
    const record = toAssessmentInput(scoped, {
      createdById: "u",
      sourceRequirementId: null,
      sourceProjectId: null,
    });
    expect(record.portfolioVerdict).toBe("not-checked");
  });

  it("none of them analysed: nothing is left out, the verdict is as it was, and they are named", () => {
    const gap = gapOf(products);
    const unanalysed = impactOf([
      ["p-commerce", "direct-change"],
      ["p-old-1", "none", false, false],
      ["p-old-2", "none", false, false],
    ]);
    const scoped = scopedToChange(gap, unanalysed);
    expect(scoped.verdict).toBe(gap.verdict);
    expect(scoped.notInScope).toEqual([]);
    expect(scoped.summary).toBe(
      "Could not verify across the portfolio: of 6 products, 2 not checked. Walkthrough 1 and Walkthrough 2 were not checked and have never been analysed, so whether this change reaches them is not known.",
    );
  });

  it("a product the walk lists none but that is connected to the change stays in the verdict", () => {
    // #1963 — further out than the walk's depth, or upstream of a changed product:
    // the walk reads `none`, but a path of edges links it, so it is not unrelated.
    const connected = impactOf([
      ["p-commerce", "direct-change"],
      ["p-orders", "direct-change"],
      ["p-billing", "downstream-consumer"],
      ["p-notify", "downstream-consumer"],
      ["p-old-1", "none", false, true, true],
      ["p-old-2", "none"],
    ]);
    const scoped = scopedToChange(gapOf(products), connected);
    expect(scoped.verdict).toBe("could-not-verify");
    expect(scoped.notInScope).toEqual(["p-old-2"]);
    expect(scoped.summary).toBe(
      "Could not verify across the portfolio: of 5 products in scope, 1 not checked. Walkthrough 2 was not checked, but it is not connected to any product this change touches, so it is not in scope.",
    );
  });

  it("one unrelated product reads in the singular", () => {
    const scoped = scopedToChange(gapOf(products.slice(0, 5)), issueImpact);
    expect(scoped.summary).toBe(
      "Nothing checked covers this. Walkthrough 1 was not checked, but it is not connected to any product this change touches, so it is not in scope.",
    );
  });

  it("with no product that changes, nothing is known to be unrelated: the result is as it was", () => {
    const gap = gapOf(products);
    const none = impactOf(products.map((p) => [p.productId, "none"]));
    expect(scopedToChange(gap, none)).toBe(gap);
  });

  it("a product the change may reach through a restricted one, or one restricted, stays in", () => {
    const gap = gapOf(products);
    const maybe = impactOf([
      ["p-commerce", "direct-change"],
      ["p-old-1", "restricted"],
      ["p-old-2", "none", true],
    ]);
    expect(scopedToChange(gap, maybe)).toBe(gap);
  });
});

describe("#1726 — a reasoning model, a cut-off reply, a failed repo, a shared repo", () => {
  const ANSWER = JSON.stringify({
    criteria: [{ index: 1, verdict: "gap-confirmed" }],
  });
  const search = async () => found([hit("rc-p1", "a.ts", "a"), hit("rc-p2", "b.ts", "b")]);

  /**
   * A model that reasons for `reasoning` tokens before it writes anything, from
   * the same `max_tokens`: under that cap it returns nothing, cut off.
   */
  function reasoningProvider(reasoning: number, answer = ANSWER) {
    const caps: number[] = [];
    const p = {
      key: "openai",
      model: "m",
      offline: false,
      chat: vi.fn(async (_m: unknown, opts: { maxTokens?: number }) => {
        const cap = opts.maxTokens ?? 0;
        caps.push(cap);
        return cap > reasoning
          ? reply(answer)
          : { ...reply(""), finishReason: "max_tokens" as const };
      }),
    } as unknown as AIProvider;
    return { p, caps };
  }

  it("a reasoning-length reply fits the cap: 6,000 tokens of reasoning, then the verdict", async () => {
    const { p, caps } = reasoningProvider(6_000);
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1"], ...ALL },
      { provider: p, search, limits },
    );
    // The old 2,000 cap returned nothing here, every time.
    expect(caps.every((c) => c >= 21_000)).toBe(true);
    expect(result.products.map((r) => r.repos[0].reason)).toEqual([null, null]);
    expect(result.products.map((r) => r.coverage)).toEqual(["not-covered", "not-covered"]);
  });

  it("an empty max_tokens reply is retried once with a larger cap before it is a failure", async () => {
    // Past the default cap, inside twice it.
    const { p, caps } = reasoningProvider(30_000);
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1"], ...ALL },
      { provider: p, search, limits },
    );
    // Two repos, two products at once: each call, then its one retry at twice the cap.
    expect([...caps].sort((a, b) => a - b)).toEqual([21_000, 21_000, 42_000, 42_000]);
    expect(result.products.map((r) => r.repos[0].reason)).toEqual([null, null]);
  });

  it("a reply cut off twice is a model error, and the retry is a counted call", async () => {
    const { p, caps } = reasoningProvider(100_000);
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1"], ...ALL },
      { provider: p, search, limits },
    );
    // Two repos, two products at once: each call, then its one retry at twice the cap.
    expect([...caps].sort((a, b) => a - b)).toEqual([21_000, 21_000, 42_000, 42_000]);
    expect(result.products.map((r) => r.repos[0].reason)).toEqual(["model-error", "model-error"]);
    // One call left: the first repo's call, and no retry, so the second is not judged.
    const capped = reasoningProvider(100_000);
    const one = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1"], ...ALL },
      { provider: capped.p, search, limits: { ...limits, maxModelCalls: 1 }, costOf: () => 0 },
    );
    expect(capped.caps).toEqual([21_000]);
    expect(one.products.map((r) => r.repos[0].reason)).toEqual(["model-error", "budget"]);
    // Three calls: both repos' calls and one retry; the retry counted leaves none for a fourth.
    const three = reasoningProvider(100_000);
    await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1"], ...ALL },
      { provider: three.p, search, limits: { ...limits, maxModelCalls: 3 }, costOf: () => 0 },
    );
    expect(three.caps).toHaveLength(3);
  });

  it("a reply that is not JSON for another reason is not retried", async () => {
    const p = provider(() => "I cannot help with that.");
    await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1"], ...ALL },
      { provider: p, search, limits },
    );
    expect(p.chat).toHaveBeenCalledTimes(2);
  });

  it("a repo in two products is assessed once, and both products read its verdict", async () => {
    db.productRepo.findMany.mockImplementation(async ({ where }) =>
      (where.productId.in as string[]).map((productId) => ({
        productId,
        repoConnectionId: "rc-shared",
        repoConnection: {
          projectId: "proj",
          label: "acme/shared",
          ownerOrOrg: null,
          repoName: null,
        },
      })),
    );
    const p = provider(() =>
      JSON.stringify({ criteria: [{ index: 1, verdict: "implemented", excerpts: [1] }] }),
    );
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1"], ...ALL },
      {
        provider: p,
        search: async () => found([hit("rc-shared", "a.ts", "a")]),
        limits,
        costOf: () => 0.01,
      },
    );
    expect(p.chat).toHaveBeenCalledTimes(1);
    const [one, two] = result.products;
    expect(one.repos[0]).toEqual(
      expect.objectContaining({ productId: "p1", verdict: "implemented", costUsd: 0.01 }),
    );
    expect(two.repos[0]).toEqual(
      expect.objectContaining({ productId: "p2", verdict: "implemented", costUsd: 0 }),
    );
    expect(result.costUsd).toBeCloseTo(0.01);
  });

  it("a shared repo reads the same in a product whose own search returned nothing for it", async () => {
    db.productRepo.findMany.mockImplementation(async ({ where }) =>
      (where.productId.in as string[]).map((productId) => ({
        productId,
        repoConnectionId: "rc-shared",
        repoConnection: {
          projectId: "proj",
          label: "acme/shared",
          ownerOrOrg: null,
          repoName: null,
        },
      })),
    );
    const p = provider(() =>
      JSON.stringify({ criteria: [{ index: 1, verdict: "implemented", excerpts: [1] }] }),
    );
    let searches = 0;
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1"], ...ALL },
      {
        provider: p,
        // The first product's search finds the repo; the second product's finds nothing.
        search: async () => found(searches++ === 0 ? [hit("rc-shared", "a.ts", "a")] : []),
        limits: { ...limits, concurrency: 1 },
      },
    );
    expect(p.chat).toHaveBeenCalledTimes(1);
    expect(result.products.map((r) => r.repos[0].verdict)).toEqual(["implemented", "implemented"]);
    expect(result.products.map((r) => r.repos[0].reason)).toEqual([null, null]);
  });

  it("one repo's failure keeps the gap another repo confirmed, and the summaries name the failure", async () => {
    db.productRepo.findMany.mockImplementation(async () => [
      {
        productId: "p1",
        repoConnectionId: "rc-orders",
        repoConnection: {
          projectId: "proj",
          label: "acme/orders",
          ownerOrOrg: null,
          repoName: null,
        },
      },
      {
        productId: "p1",
        repoConnectionId: "rc-billing",
        repoConnection: {
          projectId: "proj",
          label: "acme/billing",
          ownerOrOrg: null,
          repoName: null,
        },
      },
    ]);
    db.product.findMany.mockResolvedValue([{ id: "p1", name: "Commerce" }]);
    const p = provider((prompt) => {
      if (prompt.includes("acme/billing")) throw new Error("provider 500");
      return ANSWER;
    });
    const result = await evaluatePortfolioGap(
      USER,
      { statement: "s", criteria: ["c1"], ...ALL },
      {
        provider: p,
        search: async () => found([hit("rc-orders", "a.ts", "a"), hit("rc-billing", "b.ts", "b")]),
        limits,
      },
    );
    const [commerce] = result.products;
    // An unchecked repo may still cover it: not "not covered" (NFR-2) ...
    expect(commerce.coverage).toBe("not-checked");
    // ... but the gap orders confirmed is kept, and said.
    expect(commerce.repos.find((r) => r.label === "acme/orders")?.verdict).toBe("gap-confirmed");
    const record = toAssessmentInput(result, {
      createdById: "u",
      sourceRequirementId: null,
      sourceProjectId: null,
    }).products![0];
    expect(record.baSummary).toBe(
      "Not checked. The check failed (model error) on acme/billing; re-run to retry. acme/orders does not cover it.",
    );
    expect(result.summary).toContain(
      "The check failed (model error) on acme/billing, so this answer leaves it out; re-run to retry.",
    );
  });
});
