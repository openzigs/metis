/**
 * #1277 — the prompt-cache savings report: what each `agentStep` × model pair
 * would have paid for the same input tokens uncached, minus what it paid.
 */
import { describe, expect, it } from "vitest";
import { ConfigService } from "../config/config-service.js";
import {
  CACHE_SAVINGS_SQL,
  formatCacheSavingsTable,
  summarizeCacheSavings,
  type LedgerCacheRow,
} from "./cache-savings-report.js";

const configWith = (env: Record<string, string>) => new ConfigService({ env, vault: {} as never });
const noPrices = configWith({});

const row = (over: Partial<LedgerCacheRow>): LedgerCacheRow => ({
  agentStep: "docs-gen",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requestTokens: null,
  ...over,
});

describe("summarizeCacheSavings", () => {
  it("a cache write that is never read costs the 1.25x surcharge: a negative saving", () => {
    // Sonnet 5.5: $2 / MTok input, $2.50 / MTok 5-minute write.
    const [line] = summarizeCacheSavings([row({ cacheWriteTokens: 1_000_000 })], {
      config: noPrices,
    });
    expect(line!.uncachedUsd).toBeCloseTo(2, 9);
    expect(line!.actualUsd).toBeCloseTo(2.5, 9);
    expect(line!.netSavingUsd).toBeCloseTo(-0.5, 9);
  });

  it("a read on Sonnet 5.5 bills 0.05x input", () => {
    const [line] = summarizeCacheSavings([row({ cacheReadTokens: 1_000_000 })], {
      config: noPrices,
    });
    expect(line!.actualUsd).toBeCloseTo(0.1, 9);
    expect(line!.netSavingUsd).toBeCloseTo(1.9, 9);
    expect(line!.readShare).toBe(1);
  });

  it("a 1-hour write bills 2x input", () => {
    const [line] = summarizeCacheSavings([row({ cacheWriteTokens: 1_000_000 })], {
      config: noPrices,
      ttl: "1h",
    });
    expect(line!.actualUsd).toBeCloseTo(4, 9);
    expect(line!.netSavingUsd).toBeCloseTo(-2, 9);
  });

  it("uncached input costs the same either way and leaves the saving at zero", () => {
    const [line] = summarizeCacheSavings([row({ inputTokens: 500_000, outputTokens: 9_999 })], {
      config: noPrices,
    });
    expect(line!.uncachedUsd).toBeCloseTo(1, 9);
    expect(line!.netSavingUsd).toBeCloseTo(0, 9);
  });

  it("prices a model from MODEL_PRICES; with no write price a write costs the input price", () => {
    const config = configWith({
      MODEL_PRICES: JSON.stringify({
        "deepseek-flash": { inputPerMTok: 0.3, outputPerMTok: 1.2, cacheReadPerMTok: 0.006 },
      }),
    });
    const [line] = summarizeCacheSavings(
      [row({ model: "deepseek-flash", inputTokens: 1_000_000, cacheReadTokens: 1_000_000 })],
      { config },
    );
    expect(line!.uncachedUsd).toBeCloseTo(0.6, 9);
    expect(line!.actualUsd).toBeCloseTo(0.306, 9);
    expect(line!.netSavingUsd).toBeCloseTo(0.294, 9);
    const [writes] = summarizeCacheSavings(
      [row({ model: "deepseek-flash", cacheWriteTokens: 1_000_000 })],
      { config },
    );
    expect(writes!.netSavingUsd).toBeCloseTo(0, 9);
  });

  it("an unpriced model keeps its token counts and reports no dollar figures", () => {
    const [line] = summarizeCacheSavings(
      [row({ model: "mystery-model", cacheReadTokens: 10, inputTokens: 30 })],
      { config: noPrices },
    );
    expect(line!.cacheReadTokens).toBe(10);
    expect(line!.inputTokens).toBe(30);
    expect(line!.netSavingUsd).toBeNull();
    expect(line!.uncachedUsd).toBeNull();
  });

  it("reads the OpenAI-compatible convention: the gateway's prompt count includes the reads", () => {
    const [line] = summarizeCacheSavings(
      [
        row({
          provider: "bedrock-gateway",
          model: "global.anthropic.claude-sonnet-5-5",
          inputTokens: 1_000_000,
          cacheReadTokens: 400_000,
        }),
      ],
      { config: noPrices },
    );
    expect(line!.inputTokens).toBe(600_000);
    expect(line!.cacheReadTokens).toBe(400_000);
    expect(line!.uncachedUsd).toBeCloseTo(2, 9);
  });

  it("prices a summed row request by request, each in its own Haiku 5.5 tier", () => {
    // Two requests: one long (over 100,000 tokens, $0.50 / MTok) and one short ($0.10).
    const requests = [
      [150_000, 0, 0, 0],
      [0, 0, 50_000, 0],
    ];
    const [line] = summarizeCacheSavings(
      [
        row({
          model: "claude-haiku-5-5",
          inputTokens: 150_000,
          cacheReadTokens: 50_000,
          requestTokens: JSON.stringify(requests),
        }),
      ],
      { config: noPrices },
    );
    // uncached: 150k at $0.50 + 50k at $0.10; actual: 150k at $0.50 + 50k at $0.01.
    expect(line!.uncachedUsd).toBeCloseTo(0.075 + 0.005, 9);
    expect(line!.actualUsd).toBeCloseTo(0.075 + 0.0005, 9);
  });

  it("groups by agentStep x provider x model and lists the worst saving first", () => {
    const lines = summarizeCacheSavings(
      [
        row({ agentStep: "chat", cacheReadTokens: 1_000_000 }),
        row({ agentStep: "spec-kit.plan", cacheWriteTokens: 600_000 }),
        row({ agentStep: "spec-kit.plan", cacheWriteTokens: 400_000 }),
        row({ agentStep: null, inputTokens: 5 }),
      ],
      { config: noPrices },
    );
    expect(lines.map((l) => [l.agentStep, l.calls])).toEqual([
      ["spec-kit.plan", 2],
      ["(none)", 1],
      ["chat", 1],
    ]);
    expect(lines[0]!.cacheWriteTokens).toBe(1_000_000);
  });
});

describe("formatCacheSavingsTable", () => {
  it("renders one markdown row per pair, with a total", () => {
    const text = formatCacheSavingsTable(
      summarizeCacheSavings([row({ agentStep: "chat", cacheReadTokens: 1_000_000 })], {
        config: noPrices,
      }),
    );
    expect(text).toContain("| agentStep | provider | model |");
    expect(text).toMatch(
      /\| chat \| anthropic \| claude-sonnet-5-5 \| 1 \| 0 \| 1,000,000 \| 0 \|/,
    );
    expect(text).toContain("$1.9000");
    expect(text).toMatch(/\| \*\*total\*\* \|/);
  });

  it("prints an unpriced saving as n/a, never as zero", () => {
    const text = formatCacheSavingsTable(
      summarizeCacheSavings([row({ model: "mystery-model", inputTokens: 1 })], {
        config: noPrices,
      }),
    );
    expect(text).toContain("n/a");
  });
});

describe("CACHE_SAVINGS_SQL", () => {
  it("is a read-only aggregate by agentStep and model over token_usages", () => {
    expect(CACHE_SAVINGS_SQL).toMatch(/^SELECT/i);
    expect(CACHE_SAVINGS_SQL).toContain("token_usages");
    expect(CACHE_SAVINGS_SQL).toMatch(/GROUP BY/i);
    expect(CACHE_SAVINGS_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);
  });
});
