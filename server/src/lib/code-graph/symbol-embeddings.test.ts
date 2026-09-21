/**
 * Epic #507 / Issue #508 — Unit tests for SymbolEmbeddingPipeline.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  SymbolEmbeddingPipeline,
  formatSymbolForEmbedding,
  computeSymbolHash,
  type SymbolForEmbedding,
  type SymbolEmbeddingStore,
  type EmbedService,
  type PipelineProgress,
  type SymbolEmbeddingRow,
} from "./symbol-embeddings.js";
import { MAX_EMBED_TEXT_CHARS } from "../rag/embed-model-config.js";

// ---- Helpers --------------------------------------------------------------

function makeSymbol(overrides: Partial<SymbolForEmbedding> = {}): SymbolForEmbedding {
  return {
    symbolId: "sym-1",
    name: "myFunction",
    qualifiedName: "module.myFunction",
    kind: "function",
    filePath: "src/index.ts",
    signature: "function myFunction(a: string): void",
    docstring: "Does something useful.",
    bodyLines: ["  const x = 1;", "  return x;"],
    ...overrides,
  };
}

class MockEmbeddingStore implements SymbolEmbeddingStore {
  hashes: Map<string, string> = new Map();
  upserted: SymbolEmbeddingRow[] = [];
  deletedIds: string[] = [];

  async getExistingHashes(_projectId: string): Promise<Map<string, string>> {
    return new Map(this.hashes);
  }

  async upsert(_projectId: string, rows: SymbolEmbeddingRow[]): Promise<void> {
    this.upserted.push(...rows);
  }

  async deleteBySymbolIds(_projectId: string, symbolIds: string[]): Promise<number> {
    this.deletedIds.push(...symbolIds);
    return symbolIds.length;
  }
}

class MockEmbedService implements EmbedService {
  callCount = 0;
  lastTexts: string[] = [];

  async embed(texts: string[]) {
    this.callCount++;
    this.lastTexts = texts;
    return {
      vectors: texts.map((_, i) => Array(384).fill(0.1 * (i + 1))),
      model: "test-model",
      dimension: 384,
    };
  }
}

// ---- Tests ----------------------------------------------------------------

describe("formatSymbolForEmbedding", () => {
  it("formats a full symbol with all fields", () => {
    const sym = makeSymbol();
    const result = formatSymbolForEmbedding(sym);

    expect(result).toContain("function myFunction in src/index.ts");
    expect(result).toContain("function myFunction(a: string): void");
    expect(result).toContain("Does something useful.");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("return x;");
  });

  it("handles symbol without optional fields", () => {
    const sym = makeSymbol({
      signature: undefined,
      docstring: undefined,
      bodyLines: undefined,
    });
    const result = formatSymbolForEmbedding(sym);

    expect(result).toBe("function myFunction in src/index.ts");
  });

  it("truncates body to 10 lines", () => {
    const bodyLines = Array.from({ length: 20 }, (_, i) => `  line ${i}`);
    const sym = makeSymbol({ bodyLines });
    const result = formatSymbolForEmbedding(sym);

    expect(result).toContain("line 0");
    expect(result).toContain("line 9");
    expect(result).not.toContain("line 10");
  });

  it("handles empty body lines array", () => {
    const sym = makeSymbol({ bodyLines: [] });
    const result = formatSymbolForEmbedding(sym);

    expect(result).not.toContain("\n\n"); // no extra empty line
  });

  it("caps output at MAX_EMBED_TEXT_CHARS even for a single pathologically long body line", () => {
    // A minified/generated file can have a handful of enormous lines; MAX_BODY_LINES
    // bounds LINE COUNT, not length, so one such line still blows past any sane size.
    const sym = makeSymbol({ bodyLines: ["x".repeat(100_000)] });
    const result = formatSymbolForEmbedding(sym);

    expect(result.length).toBeLessThanOrEqual(MAX_EMBED_TEXT_CHARS);
  });

  it("caps a pre-formatted text replayed verbatim too", () => {
    const sym = makeSymbol({ text: "y".repeat(100_000) });
    const result = formatSymbolForEmbedding(sym);

    expect(result.length).toBe(MAX_EMBED_TEXT_CHARS);
  });
});

describe("computeSymbolHash", () => {
  it("returns a SHA-256 hex string", () => {
    const hash = computeSymbolHash("test content");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns same hash for same content", () => {
    const h1 = computeSymbolHash("hello");
    const h2 = computeSymbolHash("hello");
    expect(h1).toBe(h2);
  });

  it("returns different hash for different content", () => {
    const h1 = computeSymbolHash("hello");
    const h2 = computeSymbolHash("world");
    expect(h1).not.toBe(h2);
  });
});

describe("SymbolEmbeddingPipeline", () => {
  let store: MockEmbeddingStore;
  let embedService: MockEmbedService;
  let pipeline: SymbolEmbeddingPipeline;

  beforeEach(() => {
    store = new MockEmbeddingStore();
    embedService = new MockEmbedService();
    pipeline = new SymbolEmbeddingPipeline(store, embedService);
  });

  it("embeds all symbols when no existing hashes", async () => {
    const symbols = [
      makeSymbol({ symbolId: "s1", name: "foo" }),
      makeSymbol({ symbolId: "s2", name: "bar" }),
    ];

    const result = await pipeline.run({ projectId: "proj-1", symbols });

    expect(result.totalSymbols).toBe(2);
    expect(result.embedded).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.deleted).toBe(0);
    expect(embedService.callCount).toBe(1); // single batch
    expect(store.upserted).toHaveLength(2);
  });

  it("skips symbols with matching hash (incremental)", async () => {
    const sym = makeSymbol({ symbolId: "s1", name: "foo" });
    const formatted = formatSymbolForEmbedding(sym);
    const hash = computeSymbolHash(formatted);

    // Pre-populate store with matching hash
    store.hashes.set("s1", hash);

    const result = await pipeline.run({ projectId: "proj-1", symbols: [sym] });

    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(embedService.callCount).toBe(0);
    expect(store.upserted).toHaveLength(0);
  });

  it("re-embeds symbols whose hash changed", async () => {
    const sym = makeSymbol({ symbolId: "s1", name: "foo" });

    // Pre-populate with a stale hash
    store.hashes.set("s1", "stale-hash-value");

    const result = await pipeline.run({ projectId: "proj-1", symbols: [sym] });

    expect(result.embedded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(store.upserted).toHaveLength(1);
    expect(store.upserted[0].metadata.symbolId).toBe("s1");
  });

  it("deletes embeddings for symbols no longer in the set", async () => {
    // Existing hash for a symbol that is NOT in the current set
    store.hashes.set("old-symbol", "some-hash");

    const result = await pipeline.run({
      projectId: "proj-1",
      symbols: [makeSymbol({ symbolId: "s1" })],
    });

    expect(result.deleted).toBe(1);
    expect(store.deletedIds).toContain("old-symbol");
  });

  it("batches embedding calls by batchSize", async () => {
    const symbols = Array.from({ length: 5 }, (_, i) =>
      makeSymbol({ symbolId: `s${i}`, name: `fn${i}` }),
    );

    await pipeline.run({ projectId: "proj-1", symbols, batchSize: 2 });

    // 5 symbols with batch size 2 = 3 batches (2 + 2 + 1)
    expect(embedService.callCount).toBe(3);
  });

  it("emits progress callbacks", async () => {
    const symbols = [
      makeSymbol({ symbolId: "s1", name: "foo" }),
      makeSymbol({ symbolId: "s2", name: "bar" }),
    ];

    const progressUpdates: PipelineProgress[] = [];
    const onProgress = (p: PipelineProgress) => progressUpdates.push({ ...p });

    await pipeline.run({ projectId: "proj-1", symbols, onProgress });

    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[0].phase).toBe("embedding");
    expect(progressUpdates[progressUpdates.length - 1].phase).toBe("done");
  });

  it("stores correct metadata in embedding rows", async () => {
    const sym = makeSymbol({
      symbolId: "s1",
      name: "myFn",
      qualifiedName: "mod.myFn",
      kind: "function",
      filePath: "src/util.ts",
    });

    await pipeline.run({ projectId: "proj-1", symbols: [sym] });

    expect(store.upserted).toHaveLength(1);
    const row = store.upserted[0];
    expect(row.id).toBe("sym-embed-s1");
    expect(row.metadata.symbolId).toBe("s1");
    expect(row.metadata.filePath).toBe("src/util.ts");
    expect(row.metadata.kind).toBe("function");
    expect(row.metadata.name).toBe("myFn");
    expect(row.metadata.qualifiedName).toBe("mod.myFn");
    expect(row.metadata.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("handles empty symbols array", async () => {
    const result = await pipeline.run({ projectId: "proj-1", symbols: [] });

    expect(result.totalSymbols).toBe(0);
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(embedService.callCount).toBe(0);
  });

  it("reports duration in result", async () => {
    const result = await pipeline.run({
      projectId: "proj-1",
      symbols: [makeSymbol()],
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("vector has correct dimensions from embed service", async () => {
    await pipeline.run({
      projectId: "proj-1",
      symbols: [makeSymbol({ symbolId: "s1" })],
    });

    expect(store.upserted[0].vector).toHaveLength(384);
  });
});
