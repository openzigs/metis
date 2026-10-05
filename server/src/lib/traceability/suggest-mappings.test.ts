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
  DEFAULT_SUGGEST_MAX_OUTPUT_TOKENS,
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

function fakeKnowledge(
  hits: { filename: string; text: string; score?: number; source?: string }[],
) {
  return {
    search: vi.fn(async () => ({
      hits: hits.map((h) => ({
        filename: h.filename,
        text: h.text,
        score: h.score ?? 0.9,
        source: h.source ?? (h.filename.startsWith("connector:db:") ? "db" : "upload"),
      })),
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

  // #547 — an upload stored before #540 under a schema-doc name is not a
  // database table: the hit's source says so, whatever its filename.
  it("ignores a connector-shaped upload: only a db-sourced hit is a table", async () => {
    const provider = fakeProvider(JSON.stringify({ candidates: [] }));
    const result = await suggestMappings("proj-1", "req-1", {
      prisma: fakePrisma({ requirement: REQUIREMENT }),
      knowledge: fakeKnowledge([
        { filename: "connector:db:db-1:public.users.md", text: "an upload", source: "upload" },
      ]),
      provider,
      env: {},
    });

    expect(result.candidates).toEqual([]);
    expect(result.note).toMatch(/no ingested database schema/i);
    expect(provider.chat).not.toHaveBeenCalled();
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

// ── #751 AC4 — output cap and truncation handling ────────────────────────

describe("suggestMappings output cap (#751)", () => {
  const FOUR_TABLES = ["users", "orders", "items", "payments"].map((t) => ({
    filename: `connector:db:db-1:public.${t}.md`,
    text: `# public.${t}`,
  }));
  const candidateFor = (table: string) => ({
    dbConnectorId: "db-1",
    schemaName: "public",
    tableName: table,
    confidence: 0.9,
    rationale: "r",
  });
  /** Truncated on the listed calls; otherwise one candidate per table the prompt lists. */
  function truncatingProvider(truncateCalls: number[] = [1], finishReason = "max_tokens") {
    let call = 0;
    const chat = vi.fn(
      async (messages: Array<{ role: string; content: string }>, _opts?: unknown) => {
        call += 1;
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        if (truncateCalls.includes(call)) {
          return {
            content: '{"candidates":[{"dbConnectorId":"db-1","schemaName":"pub',
            finishReason,
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          };
        }
        const tables = [...user.matchAll(/\| public\.(\w+)/g)].map((m) => m[1]!);
        return {
          content: JSON.stringify({ candidates: tables.map(candidateFor) }),
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        };
      },
    );
    return { provider: { chat } as unknown as AIProvider, chat };
  }
  const deps = (provider: AIProvider, env: NodeJS.ProcessEnv = {}): SuggestDeps => ({
    prisma: fakePrisma({ requirement: REQUIREMENT, connectors: [{ id: "db-1", label: "DB" }] }),
    knowledge: fakeKnowledge(FOUR_TABLES),
    provider,
    env,
  });
  const userOf = (chat: ReturnType<typeof vi.fn>, n: number): string =>
    (chat.mock.calls[n]![0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === "user",
    )!.content;

  it("sends an explicit output cap on every call, overridable by env", async () => {
    const { provider, chat } = truncatingProvider([]);
    await suggestMappings("proj-1", "req-1", deps(provider));
    expect(chat.mock.calls[0]![1]).toMatchObject({ maxTokens: DEFAULT_SUGGEST_MAX_OUTPUT_TOKENS });

    const second = truncatingProvider([]);
    await suggestMappings(
      "proj-1",
      "req-1",
      deps(second.provider, { DATA_MAPPING_SUGGEST_MAX_OUTPUT_TOKENS: "3000" }),
    );
    expect(second.chat.mock.calls[0]![1]).toMatchObject({ maxTokens: 3000 });
  });

  it("re-asks a cap-truncated batch as two halves instead of skipping it", async () => {
    const { provider, chat } = truncatingProvider([1]);
    const result = await suggestMappings("proj-1", "req-1", deps(provider));

    expect(chat).toHaveBeenCalledTimes(3);
    expect(userOf(chat, 1)).toContain("public.users");
    expect(userOf(chat, 1)).toContain("public.orders");
    expect(userOf(chat, 1)).not.toContain("public.items");
    expect(userOf(chat, 2)).toContain("public.items");
    expect(userOf(chat, 2)).toContain("public.payments");
    expect(result.candidates.map((c) => c.tableName).sort()).toEqual([
      "items",
      "orders",
      "payments",
      "users",
    ]);
    expect(result.budgetExhausted).toBe(false);
  });

  it("still skips (does not split) a batch that is unparseable but NOT truncated", async () => {
    const { provider, chat } = truncatingProvider([1], "stop");
    const result = await suggestMappings("proj-1", "req-1", deps(provider));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.candidates).toEqual([]);
  });

  it("does not split a single-table batch forever", async () => {
    const { provider, chat } = truncatingProvider([1, 2, 3, 4, 5]);
    const result = await suggestMappings(
      "proj-1",
      "req-1",
      deps(provider, {
        DATA_MAPPING_SUGGEST_TABLES_PER_CALL: "1",
        DATA_MAPPING_SUGGEST_MAX_CALLS: "10",
      }),
    );
    // One call per table, each truncated and skipped: a single table is never re-asked.
    expect(chat).toHaveBeenCalledTimes(4);
    expect(result.candidates).toEqual([]);
  });

  it("keeps the halves inside the call budget and reports the shortfall", async () => {
    const { provider, chat } = truncatingProvider([1]);
    const result = await suggestMappings(
      "proj-1",
      "req-1",
      deps(provider, { DATA_MAPPING_SUGGEST_MAX_CALLS: "2" }),
    );
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.budgetExhausted).toBe(true);
    expect(result.candidates.map((c) => c.tableName).sort()).toEqual(["orders", "users"]);
  });
});
