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
    expect(portfolioSummary("gap-confirmed", products.slice(0, 3))).toBe(
      "Nothing in the portfolio covers this. A, B, C have no repositories to check.",
    );
  });

  it("never puts a raw product id into the prose", () => {
    const text = portfolioSummary("gap-confirmed", [empty("p-raw-id", null), empty("p2", "Two")]);
    expect(text).toBe(
      "Nothing in the portfolio covers this. a product, Two have no repositories to check.",
    );
    expect(text).not.toContain("p-raw-id");
  });
});
