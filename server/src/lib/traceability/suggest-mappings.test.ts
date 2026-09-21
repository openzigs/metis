/**
 * Suggest-mappings service tests — Epic #889 (#893).
 *
 * Fully dependency-injected: no live RAG, provider, or DB. Covers candidate
 * generation (mocked LLM), budget cutoff, empty-schema graceful path,
 * never-throws behavior, filename parsing, and hallucination rejection.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider } from "../ai/types.js";
import {
  loadSuggestConfig,
  parseSchemaDocFilename,
  suggestMappings,
  type SuggestDeps,
} from "./suggest-mappings.js";

// ── Fakes ────────────────────────────────────────────────────────────────

function fakeProvider(jsonByCall: string[] | string): AIProvider {
  const queue = Array.isArray(jsonByCall) ? [...jsonByCall] : null;
  const chat = vi.fn(async () => ({
    content: queue ? (queue.shift() ?? "{}") : (jsonByCall as string),
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
  }));
  return { chat } as unknown as AIProvider;
}

function fakeKnowledge(hits: { filename: string; text: string; score?: number }[]) {
  return {
    search: vi.fn(async () => ({
      hits: hits.map((h) => ({ filename: h.filename, text: h.text, score: h.score ?? 0.9 })),
    })),
  };
}

function fakePrisma(opts: {
  requirement?: { id: string; title: string; body: string } | null;
  connectors?: { id: string; label: string }[];
}) {
  return {
    requirement: { findFirst: vi.fn(async () => opts.requirement ?? null) },
    databaseConnection: {
      findMany: vi.fn(async () => opts.connectors ?? []),
    },
  } as unknown as NonNullable<SuggestDeps["prisma"]>;
}

const REQUIREMENT = { id: "req-1", title: "Track user emails", body: "Store and retrieve email." };
const SCHEMA_HITS = [
  { filename: "connector:db:db-1:public.users.md", text: "# public.users\nemail, id" },
  { filename: "connector:db:db-1:public.orders.md", text: "# public.orders\ntotal, user_id" },
];

describe("parseSchemaDocFilename", () => {
  it("parses a valid table doc filename", () => {
    expect(parseSchemaDocFilename("connector:db:db-1:public.users.md")).toEqual({
      dbConnectorId: "db-1",
      schemaName: "public",
      tableName: "users",
    });
  });

  it("ignores the OVERVIEW doc and non-schema filenames", () => {
    expect(parseSchemaDocFilename("connector:db:db-1:OVERVIEW.md")).toBeNull();
    expect(parseSchemaDocFilename("readme.md")).toBeNull();
    expect(parseSchemaDocFilename("connector:db:db-1:nodot.md")).toBeNull();
  });
});

describe("loadSuggestConfig", () => {
  it("falls back to defaults and honors env overrides", () => {
    expect(loadSuggestConfig({}).maxLlmCalls).toBeGreaterThan(0);
    expect(loadSuggestConfig({ DATA_MAPPING_SUGGEST_MAX_CALLS: "7" }).maxLlmCalls).toBe(7);
    // Invalid values fall back to the default.
    const def = loadSuggestConfig({}).tokenBudget;
    expect(loadSuggestConfig({ DATA_MAPPING_SUGGEST_TOKEN_BUDGET: "nope" }).tokenBudget).toBe(def);
  });
});

describe("suggestMappings", () => {
  it("returns ranked candidates with confidence + rationale (happy path)", async () => {
    const provider = fakeProvider(
      JSON.stringify({
        candidates: [
          {
            dbConnectorId: "db-1",
            schemaName: "public",
            tableName: "users",
            columnName: "email",
            confidence: 0.9,
            rationale: "email column stores user emails",
          },
          {
            dbConnectorId: "db-1",
            schemaName: "public",
            tableName: "orders",
            columnName: null,
            confidence: 0.3,
            rationale: "weakly related",
          },
        ],
      }),
    );
    const deps: SuggestDeps = {
      prisma: fakePrisma({
        requirement: REQUIREMENT,
        connectors: [{ id: "db-1", label: "Prod DB" }],
      }),
      knowledge: fakeKnowledge(SCHEMA_HITS),
      provider,
      env: {},
    };

    const result = await suggestMappings("proj-1", "req-1", deps);

    expect(result.note).toBeNull();
    expect(result.budgetExhausted).toBe(false);
    expect(result.candidates).toHaveLength(2);
    // Ranked by confidence desc.
    expect(result.candidates[0].tableName).toBe("users");
    expect(result.candidates[0]).toMatchObject({
      dbConnectorLabel: "Prod DB",
      columnName: "email",
      confidence: 0.9,
      lowConfidence: false,
      source: "llm-suggested",
    });
    expect(result.candidates[1].lowConfidence).toBe(true);
  });

  it("normalizes 0–100 confidence and drops hallucinated tables", async () => {
    const provider = fakeProvider(
      JSON.stringify({
        candidates: [
          {
            dbConnectorId: "db-1",
            schemaName: "public",
            tableName: "users",
            confidence: 80,
            rationale: "x",
          },
          // Not in the allowed set → dropped.
          {
            dbConnectorId: "db-1",
            schemaName: "public",
            tableName: "ghost",
            confidence: 0.99,
            rationale: "y",
          },
        ],
      }),
    );
    const result = await suggestMappings("proj-1", "req-1", {
      prisma: fakePrisma({
        requirement: REQUIREMENT,
        connectors: [{ id: "db-1", label: "Prod DB" }],
      }),
      knowledge: fakeKnowledge(SCHEMA_HITS),
      provider,
      env: {},
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].tableName).toBe("users");
    expect(result.candidates[0].confidence).toBeCloseTo(0.8);
  });

  it("stops at the call budget and returns partial results with a note", async () => {
    // 3 tables, 1 table per call, budget of 1 call => only first batch runs.
    const provider = fakeProvider(
      JSON.stringify({
        candidates: [
          {
            dbConnectorId: "db-1",
            schemaName: "public",
            tableName: "users",
            confidence: 0.8,
            rationale: "x",
          },
        ],
      }),
    );
    const hits = [
      { filename: "connector:db:db-1:public.users.md", text: "t1" },
      { filename: "connector:db:db-1:public.orders.md", text: "t2" },
      { filename: "connector:db:db-1:public.items.md", text: "t3" },
    ];
    const result = await suggestMappings("proj-1", "req-1", {
      prisma: fakePrisma({
        requirement: REQUIREMENT,
        connectors: [{ id: "db-1", label: "Prod DB" }],
      }),
      knowledge: fakeKnowledge(hits),
      provider,
      env: { DATA_MAPPING_SUGGEST_MAX_CALLS: "1", DATA_MAPPING_SUGGEST_TABLES_PER_CALL: "1" },
    });

    expect(result.budgetExhausted).toBe(true);
    expect(result.note).toMatch(/budget/i);
    expect(provider.chat as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("stops at the token budget before making any call", async () => {
    const provider = fakeProvider("{}");
    const result = await suggestMappings("proj-1", "req-1", {
      prisma: fakePrisma({
        requirement: REQUIREMENT,
        connectors: [{ id: "db-1", label: "Prod DB" }],
      }),
      knowledge: fakeKnowledge(SCHEMA_HITS),
      provider,
      // A 1-token budget can never fit a batch prompt -> exhausted before any call.
      env: { DATA_MAPPING_SUGGEST_TOKEN_BUDGET: "1" },
    });

    expect(result.budgetExhausted).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(provider.chat as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("applies defaults for missing fields, skips entries with no table, and dedupes", async () => {
    const provider = fakeProvider(
      JSON.stringify({
        candidates: [
          // Missing rationale + non-finite confidence -> defaults applied.
          { dbConnectorId: "db-1", schemaName: "public", tableName: "users", confidence: "bad" },
          // Duplicate tuple (same conn/schema/table/null column) -> deduped.
          {
            dbConnectorId: "db-1",
            schemaName: "public",
            tableName: "users",
            confidence: 0.2,
            rationale: "dup",
          },
          // No tableName -> skipped.
          { dbConnectorId: "db-1", schemaName: "public", confidence: 0.7, rationale: "no table" },
        ],
      }),
    );
    const result = await suggestMappings("proj-1", "req-1", {
      prisma: fakePrisma({
        requirement: REQUIREMENT,
        connectors: [{ id: "db-1", label: "Prod DB" }],
      }),
      knowledge: fakeKnowledge(SCHEMA_HITS),
      provider,
      env: {},
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      tableName: "users",
      columnName: null,
      confidence: 0.5, // non-finite fallback
      rationale: "", // missing rationale default
    });
  });

  it("returns a graceful note when no DB schema is ingested", async () => {
    const result = await suggestMappings("proj-1", "req-1", {
      prisma: fakePrisma({ requirement: REQUIREMENT }),
      knowledge: fakeKnowledge([{ filename: "readme.md", text: "not a schema doc" }]),
      provider: fakeProvider("{}"),
      env: {},
    });

    expect(result.candidates).toEqual([]);
    expect(result.note).toMatch(/no ingested database schema/i);
  });

  it("returns a note when the requirement is not in the project", async () => {
    const result = await suggestMappings("proj-1", "req-1", {
      prisma: fakePrisma({ requirement: null }),
      knowledge: fakeKnowledge(SCHEMA_HITS),
      provider: fakeProvider("{}"),
      env: {},
    });

    expect(result.candidates).toEqual([]);
    expect(result.note).toMatch(/not found/i);
  });

  it("never throws — a failing LLM batch is skipped, run still returns", async () => {
    const provider = {
      chat: vi.fn().mockRejectedValue(new Error("model exploded")),
    } as unknown as AIProvider;
    const result = await suggestMappings("proj-1", "req-1", {
      prisma: fakePrisma({
        requirement: REQUIREMENT,
        connectors: [{ id: "db-1", label: "Prod DB" }],
      }),
      knowledge: fakeKnowledge(SCHEMA_HITS),
      provider,
      env: {},
    });

    // Batch failed but the run completed without throwing.
    expect(result.candidates).toEqual([]);
    expect(result.budgetExhausted).toBe(false);
  });

  it("never throws — a failing knowledge search degrades to an error note", async () => {
    const knowledge = { search: vi.fn().mockRejectedValue(new Error("rag down")) };
    const result = await suggestMappings("proj-1", "req-1", {
      prisma: fakePrisma({ requirement: REQUIREMENT }),
      knowledge,
      provider: fakeProvider("{}"),
      env: {},
    });

    expect(result.candidates).toEqual([]);
    expect(result.note).toMatch(/suggestion failed: rag down/i);
  });
});
