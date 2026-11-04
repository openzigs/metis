import { describe, expect, it } from "vitest";
import type { EmbedService } from "../../code-graph/symbol-embeddings.js";
import { decodeRecordedVectors, recordedTextKey } from "../recorded-vectors.js";
import type { LocalizationSymbolRow } from "./corpus.js";
import {
  EMBED_BATCH,
  EmbedCache,
  assertNoMissingVectors,
  buildCorpusSearch,
  toSearchable,
} from "./search.js";

/** A toy model: one dimension per letter a–z, counted. */
class LetterModel implements EmbedService {
  calls: string[][] = [];
  constructor(private readonly model = "toy-model") {}
  async embed(texts: string[]) {
    this.calls.push(texts);
    const vectors = texts.map((t) => {
      const v = new Array(26).fill(0) as number[];
      for (const ch of t.toLowerCase()) {
        const i = ch.charCodeAt(0) - 97;
        if (i >= 0 && i < 26) v[i]! += 1;
      }
      return v;
    });
    return { vectors, model: this.model, dimension: 26 };
  }
}

function row(over: Partial<LocalizationSymbolRow>): LocalizationSymbolRow {
  return {
    id: "x",
    repo: "app",
    name: "f",
    qualifiedName: "a.ts::f",
    kind: "function",
    language: "ts",
    filePath: "a.ts",
    startLine: 1,
    endLine: 2,
    ...over,
  };
}

describe("EmbedCache", () => {
  it("embeds only what the recording lacks, in batches, and writes everything back", async () => {
    const model = new LetterModel();
    const recorded = {
      model: "toy-model",
      dimension: 26,
      vectors: new Map([[recordedTextKey("known"), new Array(26).fill(0.5) as number[]]]),
    };
    const cache = new EmbedCache(recorded, model, "re-record");
    const texts = ["known", ...Array.from({ length: EMBED_BATCH + 1 }, (_, i) => `t${i}`)];
    const out = await cache.embed([...texts, "t0"]);
    expect(out.vectors).toHaveLength(texts.length + 1);
    expect(out.vectors[0]![0]).toBe(0.5);
    expect(model.calls.map((c) => c.length)).toEqual([EMBED_BATCH, 1]);
    expect(cache.embeddedCount).toBe(EMBED_BATCH + 1);
    await cache.embed(["t0"]);
    expect(model.calls).toHaveLength(2);

    const files = cache.toFiles("note");
    expect(files.file.keys).toHaveLength(texts.length);
    const decoded = decodeRecordedVectors(files.file, files.bytes);
    expect(decoded.vectors.get(recordedTextKey("known"))![3]).toBe(0.5);
    expect(decoded.vectors.get(recordedTextKey("t1"))![19]).toBe(1);
  });

  it("without a model, refuses a text it has no vector for and remembers it", async () => {
    const cache = new EmbedCache(null, null, "pnpm eval:localization --embed");
    await expect(cache.embed(["new text"])).rejects.toThrow(/Record them with: pnpm/);
    expect(cache.missing).toEqual(["new text"]);
    expect(() => assertNoMissingVectors(cache)).toThrow(/fell back to BM25/);
  });

  it("refuses to mix two models in one recording", async () => {
    const recorded = { model: "old", dimension: 26, vectors: new Map<string, number[]>() };
    const cache = new EmbedCache(recorded, new LetterModel("new"), "x");
    await expect(cache.embed(["a"])).rejects.toThrow(/recording is old/);
  });

  it("passes a run that asked only for recorded texts", () => {
    expect(() => assertNoMissingVectors(new EmbedCache(null, null, "x"))).not.toThrow();
  });
});

describe("toSearchable", () => {
  it("carries the fields production's lexical channel reads, and only those present", () => {
    expect(
      toSearchable(row({ signature: "func f()", docComment: "does f", package: "app" })),
    ).toEqual({
      symbolId: "x",
      name: "f",
      qualifiedName: "a.ts::f",
      kind: "function",
      filePath: "a.ts",
      signature: "func f()",
      docstring: "does f",
      package: "app",
    });
    expect(toSearchable(row({}))).not.toHaveProperty("signature");
  });
});

describe("buildCorpusSearch", () => {
  const rows = [
    row({
      id: "app#1",
      name: "invoice",
      qualifiedName: "inv.ts::invoice",
      filePath: "inv.ts",
      embeddingText: "invoice total",
      writesData: true,
    }),
    row({
      id: "app#2",
      name: "receipt",
      qualifiedName: "rec.ts::receipt",
      filePath: "rec.ts",
      embeddingText: "receipt email",
    }),
    row({
      id: "app#3",
      name: "orders",
      qualifiedName: "orders",
      kind: "table",
      language: "sql",
      filePath: "schema.sql",
    }),
    row({
      id: "other#1",
      repo: "other",
      name: "invoice",
      qualifiedName: "o.ts::invoice",
      filePath: "o.ts",
      embeddingText: "invoice",
    }),
  ];

  it("searches one repository per project, with production's hybrid ranking", async () => {
    const s = await buildCorpusSearch(rows, new EmbedCache(null, new LetterModel(), "x"));
    const modes: string[] = [];
    const hits = await s.searcher.search("invoice total", "app", {
      limit: 5,
      onRetrievalMode: (m) => modes.push(m),
    });
    expect(hits[0]).toMatchObject({ symbolId: "app#1", filePath: "inv.ts" });
    expect(hits.every((h) => h.symbolId.startsWith("app#"))).toBe(true);
    expect(modes).toEqual(["hybrid"]);
    expect(await s.searcher.search("invoice", "missing", {})).toEqual([]);
    expect(s.embeddingModel).toBe("toy-model");
    expect(s.symbolsDigest).toMatch(/^[0-9a-f]{12}$/);
  });

  it("hydrates and flags writers inside the asked project only", async () => {
    const s = await buildCorpusSearch(rows, new EmbedCache(null, new LetterModel(), "x"));
    expect(await s.loadSymbols(["app#1", "other#1", "nope"], "app")).toEqual([
      {
        id: "app#1",
        qualifiedName: "inv.ts::invoice",
        filePath: "inv.ts",
        kind: "function",
        language: "ts",
        startLine: 1,
        endLine: 2,
        signature: null,
      },
    ]);
    expect(await s.loadWriterIds(["app#1", "app#2", "other#1"], "app")).toEqual(new Set(["app#1"]));
    expect(await s.loadWriterIds(["app#1"], "other")).toEqual(new Set());
  });
});
