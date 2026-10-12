/**
 * #1080 (PR #1092 review) — pricing a usage row that sums several requests.
 *
 * Claude Haiku 5.5 (https://platform.claude.com/docs/en/about-claude/pricing,
 * read 2026-10-11, USD per MTok):
 *
 *   prompt ≤ 100,000   $0.10 in / $0.50 out / $0.01 read / $0.125 write
 *   prompt > 100,000   $0.50 in / $2.50 out / $0.05 read / $0.625 write
 *
 * Every expected figure is worked by hand from that table. The end-to-end
 * cases (the chat routes, a discussion reply, a failed turn, over a real
 * database) are in `server/tests/summed-turn-prompt-tier.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const tokenUsageCreate = vi.fn(async (_: unknown) => ({}));
const aiTokenUsageCreate = vi.fn(async (_: unknown) => ({}));

vi.mock("../prisma.js", () => ({
  prisma: {
    tokenUsage: { create: (a: unknown) => tokenUsageCreate(a) },
    aITokenUsage: { create: (a: unknown) => aiTokenUsageCreate(a) },
  },
}));

import { TokenTracker, estimateSummedUsageCostUsd } from "../ai/token-tracker.js";
import { resolveRate } from "./provider-rates.js";
import {
  encodeRequestTokens,
  ledgerRequests,
  ledgerRowRequests,
  summedRequests,
} from "./summed-requests.js";
import {
  ledgerTierShares,
  priceLedgerTokensExact,
  recordUsageAndFlush,
  type StoredTokenCounts,
} from "./token-tracker.js";

const HAIKU = "claude-haiku-5-5";
const counts = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): StoredTokenCounts => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
const sum = (rows: readonly StoredTokenCounts[]): StoredTokenCounts =>
  rows.reduce(
    (a, r) =>
      counts(
        a.inputTokens + r.inputTokens,
        a.outputTokens + r.outputTokens,
        a.cacheReadTokens + r.cacheReadTokens,
        a.cacheWriteTokens + r.cacheWriteTokens,
      ),
    counts(0, 0),
  );
const rate = (model: string, provider = "anthropic") => resolveRate(provider, model);

/** Two small calls and one over the threshold. */
const MIXED = [counts(30_000, 1_000), counts(120_000, 1_000), counts(30_000, 1_000)];
// standard share  60,000 × $0.10/M + 2,000 × $0.50/M = $0.006 + $0.001   = 0.7¢
// long share     120,000 × $0.50/M + 1,000 × $2.50/M = $0.06  + $0.0025  = 6.25¢
const MIXED_CENTS = 6.95;
// The same tokens as ONE request (180,000 in / 3,000 out), all at the long prices:
// 180,000 × $0.50/M + 3,000 × $2.50/M = $0.09 + $0.0075 = 9.75¢.
const MIXED_AS_ONE_CENTS = 9.75;

beforeEach(() => {
  tokenUsageCreate.mockClear();
  aiTokenUsageCreate.mockClear();
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
  vi.stubEnv("MODEL_PRICES", "");
});

describe("summedRequests — is this row a sum, and of what", () => {
  it("returns the requests when two or more add up to the row", () => {
    expect(summedRequests(sum(MIXED), MIXED)).toEqual(MIXED);
  });

  it("is null for no list, an empty list, and a single request (the row IS the request)", () => {
    const one = counts(120_000, 1_000);
    expect(summedRequests(one, undefined)).toBeNull();
    expect(summedRequests(one, null)).toBeNull();
    expect(summedRequests(one, [])).toBeNull();
    expect(summedRequests(one, [one])).toBeNull();
  });

  it("is null when the requests do not add up to the row, on any of the four counts", () => {
    const total = sum(MIXED);
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ] as const) {
      expect(summedRequests({ ...total, [key]: total[key] + 1 }, MIXED)).toBeNull();
    }
  });

  it("reads an absent or junk cache count as zero", () => {
    const requests = [
      { inputTokens: 10, outputTokens: 1 },
      { inputTokens: 20, outputTokens: 2, cacheReadTokens: Number.NaN, cacheWriteTokens: -4 },
    ];
    expect(summedRequests(counts(30, 3), requests)).toEqual([counts(10, 1), counts(20, 2)]);
  });
});

describe("ledgerRowRequests — the stored form", () => {
  it("round-trips what encodeRequestTokens writes", () => {
    const stored = encodeRequestTokens(MIXED);
    expect(stored).toBe("[[30000,1000,0,0],[120000,1000,0,0],[30000,1000,0,0]]");
    expect(ledgerRowRequests({ requestTokens: stored })).toEqual(MIXED);
  });

  it("is null for a row with no list — every single-request and pre-#1080 row", () => {
    expect(ledgerRowRequests({})).toBeNull();
    expect(ledgerRowRequests({ requestTokens: null })).toBeNull();
    expect(ledgerRowRequests({ requestTokens: "" })).toBeNull();
  });

  it("is null, never a throw, for anything encodeRequestTokens would not write", () => {
    for (const requestTokens of [
      "not json",
      "{}",
      "[]",
      "[[1,2,3,4]]", // one request is not a sum
      "[[1,2,3,4],[1,2,3]]", // a short tuple
      "[[1,2,3,4],[1,2,3,-1]]", // a negative count
      "[[1,2,3,4],[1,2,3,1.5]]", // a fraction
      '[[1,2,3,4],[1,2,3,"4"]]', // a string
      "[[1,2,3,4],null]",
    ]) {
      expect(ledgerRowRequests({ requestTokens }), requestTokens).toBeNull();
    }
  });
});

describe("ledgerRequests — a turn's calls in the ledger's field names", () => {
  it("maps prompt/completion to input/output and keeps the cache counts", () => {
    expect(
      ledgerRequests([
        { promptTokens: 7, completionTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 },
        { promptTokens: 5, completionTokens: 4 },
      ]),
    ).toEqual([
      { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 },
      {
        inputTokens: 5,
        outputTokens: 4,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
    ]);
  });
});

describe("priceLedgerTokensExact — each request in its own price tier", () => {
  it("prices a mixed turn as the sum of its calls, not as one long request", () => {
    expect(priceLedgerTokensExact("anthropic", rate(HAIKU), sum(MIXED), MIXED)).toBeCloseTo(
      MIXED_CENTS,
      9,
    );
    // Without the list the row is one 180,000-token request.
    expect(priceLedgerTokensExact("anthropic", rate(HAIKU), sum(MIXED), null)).toBeCloseTo(
      MIXED_AS_ONE_CENTS,
      9,
    );
  });

  it("splits the row into a standard share and a long share", () => {
    const shares = ledgerTierShares("anthropic", rate(HAIKU), sum(MIXED), MIXED);
    expect(shares).toHaveLength(2);
    expect(shares.find((s) => !s.longPrompt)!.counts).toMatchObject({
      freshInputTokens: 60_000,
      outputTokens: 2_000,
      totalTokens: 62_000,
    });
    expect(shares.find((s) => s.longPrompt)!.counts).toMatchObject({
      freshInputTokens: 120_000,
      outputTokens: 1_000,
      totalTokens: 121_000,
    });
  });

  it("counts a request's cache reads and writes toward ITS prompt, exactly at the boundary", () => {
    // 60,000 in + 30,000 read + 10,000 written = 100,000: NOT over the threshold.
    const at = counts(60_000, 0, 30_000, 10_000);
    // One more input token: 100,001, over it.
    const over = counts(60_001, 0, 30_000, 10_000);
    // at:   60,000 × $0.10/M + 30,000 × $0.01/M + 10,000 × $0.125/M
    //     = 0.6¢ + 0.03¢ + 0.125¢ = 0.755¢
    // over: 60,001 × $0.50/M + 30,000 × $0.05/M + 10,000 × $0.625/M
    //     = 3.00005¢ + 0.15¢ + 0.625¢ = 3.77505¢
    expect(
      priceLedgerTokensExact("anthropic", rate(HAIKU), sum([at, over]), [at, over]),
    ).toBeCloseTo(0.755 + 3.77505, 9);
  });

  it("on the gateway convention a request's prompt count already holds its cache reads", () => {
    // Two requests of prompt_tokens 100,000, 60,000 of them cache reads: each is
    // a 100,000-token prompt (not 160,000) → lower prices, Regional SKU (1.1x):
    // 2 × (40,000 × $0.11/M + 60,000 × $0.011/M) = 2 × (0.44¢ + 0.066¢) = 1.012¢.
    const model = "us.anthropic.claude-haiku-5-5";
    const request = counts(100_000, 0, 60_000);
    expect(
      priceLedgerTokensExact(
        "bedrock-gateway",
        rate(model, "bedrock-gateway"),
        sum([request, request]),
        [request, request],
      ),
    ).toBeCloseTo(1.012, 9);
  });

  it("prices a model with no tier from the row alone, list or no list — bit for bit", () => {
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"]) {
      const withList = priceLedgerTokensExact("anthropic", rate(model), sum(MIXED), MIXED);
      const without = priceLedgerTokensExact("anthropic", rate(model), sum(MIXED), null);
      expect(withList, model).toBe(without);
      expect(ledgerTierShares("anthropic", rate(model), sum(MIXED), MIXED)).toHaveLength(1);
    }
    // Sonnet 5.5: 180,000 × $2/M + 3,000 × $10/M = 36¢ + 3¢.
    expect(
      priceLedgerTokensExact("anthropic", rate("claude-sonnet-5-5"), sum(MIXED), MIXED),
    ).toBeCloseTo(39, 9);
  });

  it("is null for an unpriced model, list or no list", () => {
    expect(priceLedgerTokensExact("openai", null, sum(MIXED), MIXED)).toBeNull();
    expect(ledgerTierShares("openai", null, sum(MIXED), MIXED)).toEqual([
      expect.objectContaining({ longPrompt: false }),
    ]);
  });
});

describe("recordUsage — token_usages", () => {
  const record = async (requests: StoredTokenCounts[] | undefined, model = HAIKU) => {
    tokenUsageCreate.mockClear();
    const result = await recordUsageAndFlush({
      projectId: "p-1",
      sessionId: "s-1",
      provider: "anthropic",
      model,
      ...sum(MIXED),
      ...(requests ? { requests } : {}),
    });
    const row = (tokenUsageCreate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    return { result, row };
  };

  it("stores a summed row at the sum of its calls' prices, and the calls with it", async () => {
    const { result, row } = await record(MIXED);
    expect(result.costUsd).toBeCloseTo(MIXED_CENTS / 100, 12);
    expect(result.costCents).toBe(7);
    expect(row).toMatchObject({
      inputTokens: 180_000,
      outputTokens: 3_000,
      totalTokens: 183_000,
      costCents: 7,
      requestTokens: encodeRequestTokens(MIXED),
    });
    expect(row.costUsd).toBeCloseTo(MIXED_CENTS / 100, 12);
  });

  it("stores a row with no list as one request, with no requestTokens key at all", async () => {
    const { result, row } = await record(undefined);
    expect(result.costUsd).toBeCloseTo(MIXED_AS_ONE_CENTS / 100, 12);
    expect(row).not.toHaveProperty("requestTokens");
  });

  it("falls back to one request when the list does not add up to the row", async () => {
    const { result, row } = await record([MIXED[0]!, MIXED[1]!]);
    expect(result.costUsd).toBeCloseTo(MIXED_AS_ONE_CENTS / 100, 12);
    expect(row).not.toHaveProperty("requestTokens");
  });

  it("a model with no tier costs the same with the list as without — and still stores it", async () => {
    const withList = await record(MIXED, "claude-sonnet-5-5");
    const without = await record(undefined, "claude-sonnet-5-5");
    expect(withList.result.costUsd).toBe(without.result.costUsd);
    expect(withList.result.costCents).toBe(39);
    expect(withList.row.requestTokens).toBe(encodeRequestTokens(MIXED));
  });
});

describe("TokenTracker — ai_token_usages", () => {
  const usage = { promptTokens: 180_000, completionTokens: 3_000 };
  const requests = MIXED.map((r) => ({
    promptTokens: r.inputTokens,
    completionTokens: r.outputTokens,
  }));
  const record = async (withRequests: boolean, model = HAIKU) => {
    aiTokenUsageCreate.mockClear();
    await new TokenTracker().recordAndFlush({
      sessionId: "s-1",
      userId: "u-1",
      provider: "anthropic",
      model,
      usage,
      ...(withRequests ? { requests } : {}),
    });
    return (aiTokenUsageCreate.mock.calls[0]![0] as { data: Record<string, number> }).data;
  };

  it("stores a summed row at the sum of its calls' prices — the ledger's figure", async () => {
    const row = await record(true);
    expect(row.estimatedCostUsd).toBeCloseTo(MIXED_CENTS / 100, 12);
    // The row itself is unchanged: one row, the summed tokens.
    expect(row).toMatchObject({ promptTokens: 180_000, completionTokens: 3_000 });
  });

  it("stores a row with no list as one request", async () => {
    expect((await record(false)).estimatedCostUsd).toBeCloseTo(MIXED_AS_ONE_CENTS / 100, 12);
  });

  it("a model with no tier costs the same with the list as without", async () => {
    const withList = (await record(true, "claude-sonnet-5-5")).estimatedCostUsd;
    expect(withList).toBe((await record(false, "claude-sonnet-5-5")).estimatedCostUsd);
    expect(withList).toBeCloseTo(0.39, 12);
  });

  it("prices each tier's 1-hour cache writes at 2x THAT tier's input price", () => {
    // Two requests, each writing its whole prompt to the 1-hour cache:
    //   50,000 written (standard): 50,000 × 2 × $0.10/M = 1¢
    //  200,000 written (long):    200,000 × 2 × $0.50/M = 20¢
    const calls = [
      { promptTokens: 0, completionTokens: 0, cacheWriteTokens: 50_000 },
      { promptTokens: 0, completionTokens: 0, cacheWriteTokens: 200_000 },
    ];
    const total = { promptTokens: 0, completionTokens: 0, cacheWriteTokens: 250_000 };
    expect(estimateSummedUsageCostUsd(HAIKU, total, "anthropic", "1h", calls)).toBeCloseTo(
      0.21,
      12,
    );
    // As one 250,000-token request it would be 250,000 × 2 × $0.50/M = 25¢.
    expect(estimateSummedUsageCostUsd(HAIKU, total, "anthropic", "1h")).toBeCloseTo(0.25, 12);
  });

  it("is null for an unpriced model", () => {
    expect(estimateSummedUsageCostUsd("mystery-model", usage, "openai", "5m", requests)).toBeNull();
  });
});
