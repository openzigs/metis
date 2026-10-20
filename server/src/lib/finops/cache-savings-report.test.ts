/**
 * #1277 — the prompt-cache savings report: what each `agentStep` × model pair
 * would have paid for the same input tokens uncached, minus what it paid.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConfigService } from "../config/config-service.js";
import {
  CACHE_SAVINGS_SQL,
  formatCacheSavingsTable,
  ledgerRowsQuery,
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

  it("`--ttl 1h` charges 2x only to a model that prices writes, never to a free-write one", () => {
    const config = configWith({
      MODEL_PRICES: JSON.stringify({
        "deepseek-flash": { inputPerMTok: 0.3, outputPerMTok: 1.2, cacheReadPerMTok: 0.006 },
      }),
    });
    const [line] = summarizeCacheSavings(
      [row({ model: "deepseek-flash", cacheWriteTokens: 1_000_000 })],
      { config, ttl: "1h" },
    );
    expect(line!.netSavingUsd).toBeCloseTo(0, 9);
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

  it("names each row's token convention, since input_tokens means two things", () => {
    // On `anthropic` the stored input EXCLUDES cache reads; on every
    // OpenAI-compatible provider it INCLUDES them.
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE token_usages ("agentStep" TEXT, provider TEXT, model TEXT,
      "inputTokens" INT, "cacheReadTokens" INT, "cacheWriteTokens" INT)`);
    db.exec(`INSERT INTO token_usages VALUES
      ('chat','anthropic','m',10,5,0), ('chat','bedrock-gateway','m',15,5,0)`);
    const rows = db.prepare(CACHE_SAVINGS_SQL).all() as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.provider, r.convention]).sort()).toEqual([
      ["anthropic", "anthropic-native: input excludes cache reads"],
      ["bedrock-gateway", "openai-compatible: input includes cache reads"],
    ]);
  });
});

describe("ledgerRowsQuery", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE token_usages ("agentStep" TEXT, provider TEXT, model TEXT,
    "inputTokens" INT, "outputTokens" INT, "cacheReadTokens" INT, "cacheWriteTokens" INT,
    "requestTokens" TEXT, "createdAt" TEXT)`);
  // The ledger stores ISO text with a `+00:00` offset.
  for (const at of ["2026-10-15T13:44:00.500+00:00", "2026-10-15T13:43:59.999+00:00"]) {
    db.prepare(`INSERT INTO token_usages VALUES ('s','anthropic','m',1,0,0,0,NULL,?)`).run(at);
  }
  const count = (opts: { since?: string; until?: string }) => {
    const { sql, params } = ledgerRowsQuery(opts);
    return db.prepare(sql).all(...params).length;
  };

  it("compares instants, not text: a `Z` bound keeps a `+00:00` row in the same second", () => {
    expect(count({ since: "2026-10-15T13:44:00Z" })).toBe(1);
    expect(count({ since: "2026-10-15T13:44:00.000+00:00" })).toBe(1);
    expect(count({ until: "2026-10-15T13:44:00Z" })).toBe(1);
    expect(count({})).toBe(2);
  });

  // #1284 — JavaScript's Date.parse accepts "October 15, 2026"; SQLite's
  // julianday() does not and returned NULL, so the report printed zero rows.
  it("normalises a non-ISO date the guard accepts before binding it", () => {
    // Local midnight on Oct 15 is before 13:43Z that day in every time zone.
    expect(count({ since: "October 15, 2026" })).toBe(2);
    expect(count({ until: "October 17, 2026" })).toBe(2);
    expect(count({ since: "October 17, 2026" })).toBe(0);
    expect(ledgerRowsQuery({ since: "2026-10-15T13:44:00Z" }).params).toEqual([
      "2026-10-15T13:44:00.000Z",
    ]);
  });

  it("rejects a bound that is not a date", () => {
    expect(() => ledgerRowsQuery({ since: "yesterday" })).toThrow(/not a date/);
  });
});
