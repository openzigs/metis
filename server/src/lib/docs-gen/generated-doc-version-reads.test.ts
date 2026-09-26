import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WeightedLru,
  cachedChangedSymbols,
  cachedProvenanceSummary,
  clearGeneratedDocVersionReadCaches,
  type GeneratedDocVersionRowKey,
} from "./generated-doc-version-reads.js";
import { legacyGeneratedDocVersionManifest } from "./generated-doc-provenance.js";

const row = (overrides: Partial<GeneratedDocVersionRowKey> = {}): GeneratedDocVersionRowKey => ({
  projectId: "p",
  documentId: "d",
  versionId: "v1",
  version: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const manifest = (sections: number) =>
  JSON.stringify({
    ...legacyGeneratedDocVersionManifest({ projectId: "p", generatedDocumentId: "d", version: 1 }),
    sections: Array.from({ length: sections }, (_, i) => ({
      sectionSlug: `s-${i}`,
      sectionLabel: `S ${i}`,
      sectionIndex: i,
      providerKind: "local",
      model: "m",
      factsSourceIds: [],
      groundingSourceIds: [],
    })),
  });

beforeEach(() => clearGeneratedDocVersionReadCaches());

describe("WeightedLru", () => {
  it("evicts the least recently used entries once over its weight", () => {
    const lru = new WeightedLru<string>(5, (v) => v.length);
    lru.set("a", "aa");
    lru.set("b", "bb");
    expect(lru.get("a")).toBe("aa"); // a is now the most recent
    lru.set("c", "cc");
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe("aa");
    expect(lru.get("c")).toBe("cc");
    expect(lru.size).toBe(2);
  });

  it("never stores a value heavier than the whole budget", () => {
    const lru = new WeightedLru<string>(3, (v) => v.length);
    lru.set("big", "xxxx");
    expect(lru.get("big")).toBeUndefined();
    expect(lru.size).toBe(0);
  });

  it("replacing a key releases the old entry's weight", () => {
    const lru = new WeightedLru<string>(4, (v) => v.length);
    lru.set("a", "aaa");
    lru.set("a", "aaa");
    lru.set("b", "b");
    expect(lru.get("a")).toBe("aaa");
    expect(lru.get("b")).toBe("b");
  });

  it("defaults to counting entries", () => {
    const lru = new WeightedLru<number>(1);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe(2);
  });
});

describe("cachedProvenanceSummary", () => {
  it("loads and parses a version's manifest once", async () => {
    const load = vi.fn(async () => manifest(3));
    const first = await cachedProvenanceSummary(row(), load);
    const second = await cachedProvenanceSummary(row(), load);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ revisionId: "gendoc:p:d:v1", sectionCount: 3 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keys on the row's createdAt, so a re-created row is read afresh", async () => {
    await cachedProvenanceSummary(row(), async () => manifest(1));
    const recreated = await cachedProvenanceSummary(
      row({ createdAt: new Date("2026-02-01T00:00:00.000Z") }),
      async () => manifest(7),
    );
    expect(recreated?.sectionCount).toBe(7);
  });

  it("keys on the project and document too", async () => {
    await cachedProvenanceSummary(row(), async () => manifest(1));
    const other = await cachedProvenanceSummary(row({ documentId: "other" }), async () => null);
    expect(other?.revisionId).toBe("gendoc:p:other:v1");
  });

  it("summarises the legacy manifest when none is stored", async () => {
    const summary = await cachedProvenanceSummary(row({ version: 4 }), async () => null);
    expect(summary).toMatchObject({
      revisionId: "gendoc:p:d:v4",
      pipeline: "holistic",
      models: { phase1: "unknown", phase2: "unknown" },
      legacy: { historicalCitations: "legacy-unknown" },
    });
  });

  it("returns null for an unreadable manifest and remembers that", async () => {
    const load = vi.fn(async () => "{not json");
    expect(await cachedProvenanceSummary(row(), load)).toBeNull();
    expect(await cachedProvenanceSummary(row(), load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("cachedChangedSymbols", () => {
  it("parses the stored array once", async () => {
    const load = vi.fn(async () => JSON.stringify(["a", "b"]));
    expect(await cachedChangedSymbols(row(), load)).toEqual(["a", "b"]);
    expect(await cachedChangedSymbols(row(), load)).toEqual(["a", "b"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([["{not json"], ['{"a":1}']])(
    "returns null for %s and does not cache it",
    async (raw) => {
      const load = vi.fn(async () => raw);
      expect(await cachedChangedSymbols(row(), load)).toBeNull();
      expect(await cachedChangedSymbols(row(), load)).toBeNull();
      expect(load).toHaveBeenCalledTimes(2);
    },
  );
});
