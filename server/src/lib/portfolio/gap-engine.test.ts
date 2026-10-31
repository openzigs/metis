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
}));
vi.mock("../prisma.js", () => ({ prisma: db }));

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

const { evaluatePortfolioGap, portfolioGapInputSchema, readPortfolioGapLimits } =
  await import("./gap-engine.js");
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
  it('a "product" scope names at least one product', () => {
    expect(portfolioGapInputSchema.safeParse({ statement: "s", scope: "product" }).success).toBe(
      false,
    );
    expect(
      portfolioGapInputSchema.safeParse({ statement: "s", scope: "product", productIds: ["p"] })
        .success,
    ).toBe(true);
  });

  it("refuses an empty statement and an unknown field", () => {
    expect(portfolioGapInputSchema.safeParse({ statement: " ", ...ALL }).success).toBe(false);
    expect(portfolioGapInputSchema.safeParse({ statement: "s", ...ALL, x: 1 }).success).toBe(false);
  });
});

describe("readPortfolioGapLimits", () => {
  it("defaults to $2 per run, $0.50 per product and 4 at once", () => {
    expect(readPortfolioGapLimits()).toMatchObject({
      runCostCapUsd: 2,
      productCostCapUsd: 0.5,
      concurrency: 4,
    });
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
