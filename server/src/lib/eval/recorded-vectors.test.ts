/**
 * #1097 — recorded embeddings for the requirement→code evals: recorded once
 * with the local model, replayed with no model, and never silently stale.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EmbedService } from "../code-graph/symbol-embeddings.js";
import {
  RecordedEmbedService,
  RecordingEmbedService,
  assertFullyRecorded,
  buildInMemorySymbolVectorStore,
  decodeRecordedVectors,
  fromFloat16Bits,
  loadRecordedVectors,
  recordedTextKey,
  recordedVectorsBinFile,
  toFloat16Bits,
  writeRecordedVectors,
} from "./recorded-vectors.js";

const fake: EmbedService = {
  async embed(texts) {
    return {
      vectors: texts.map((t) => [t.length, 1 / 3, t.includes("a") ? 1 : 0]),
      model: "m",
      dimension: 3,
    };
  },
};

describe("recorded vectors", () => {
  it("round-trips half precision: exact on representable values, within 1e-3 relative otherwise", () => {
    for (const x of [0, 1, -2, 0.5, 65504, -(2 ** -14)]) {
      expect(fromFloat16Bits(toFloat16Bits(x))).toBe(x);
    }
    for (const x of [0.0371, -0.1234567, 1 / 3, 0.000123, -0.98765]) {
      expect(Math.abs(fromFloat16Bits(toFloat16Bits(x)) - x)).toBeLessThan(Math.abs(x) * 1e-3);
    }
    expect(fromFloat16Bits(toFloat16Bits(1e6))).toBe(Number.POSITIVE_INFINITY);
    expect(fromFloat16Bits(toFloat16Bits(Number.NaN))).toBeNaN();
    expect(fromFloat16Bits(toFloat16Bits(1e-9))).toBe(0);
    // A subnormal survives (gte vectors have none, but nothing breaks on one).
    expect(fromFloat16Bits(toFloat16Bits(2 ** -20))).toBe(2 ** -20);
  });

  it("records what another embedder returns, in half precision, keyed by the text's hash", async () => {
    const recording = new RecordingEmbedService(fake);
    await recording.embed(["abc", "xyz"]);
    const { file, bytes } = recording.toFiles("note");
    expect(file).toMatchObject({ model: "m", dimension: 3, note: "note", encoding: "float16-le" });
    expect(file.keys).toEqual([recordedTextKey("abc"), recordedTextKey("xyz")].sort());
    expect(bytes).toHaveLength(2 * 3 * 2);
    const decoded = decodeRecordedVectors(file, bytes).vectors.get(recordedTextKey("abc"))!;
    expect(decoded[0]).toBe(3);
    expect(decoded[1]).toBeCloseTo(1 / 3, 3);
    expect(() => decodeRecordedVectors({ ...file, encoding: "json" as never }, bytes)).toThrow(
      /encoding/,
    );
    expect(() => decodeRecordedVectors(file, bytes.subarray(2))).toThrow(/bytes for 2 vectors/);
  });

  it("replays a recording, and keeps every text it has no vector for", async () => {
    const recording = new RecordingEmbedService(fake);
    await recording.embed(["abc"]);
    const { file, bytes } = recording.toFiles("n");
    const replay = new RecordedEmbedService(decodeRecordedVectors(file, bytes), "re-record cmd");
    const [vector] = (await replay.embed(["abc"])).vectors;
    expect(vector![0]).toBe(3);
    expect(() => assertFullyRecorded(replay)).not.toThrow();
    await expect(replay.embed(["new text"])).rejects.toThrow(/re-record cmd/);
    expect(replay.missing).toEqual(["new text"]);
    expect(() => assertFullyRecorded(replay)).toThrow(/1 text\(s\) have no recorded vector/);
    // Anything that is not a replay has nothing to check.
    expect(() => assertFullyRecorded(fake)).not.toThrow();
  });

  it("writes and loads a recording's two files, and reads a missing one as none", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "recorded-"));
    try {
      const file = path.join(dir, "v.json");
      expect(await loadRecordedVectors(file)).toBeNull();
      const recording = new RecordingEmbedService(fake);
      await recording.embed(["abc"]);
      await writeRecordedVectors(file, recording.toFiles("n"));
      expect(recordedVectorsBinFile(file)).toBe(path.join(dir, "v.bin"));
      const loaded = await loadRecordedVectors(file);
      expect(loaded).toMatchObject({ model: "m", dimension: 3 });
      expect(loaded!.vectors.get(recordedTextKey("abc"))![0]).toBe(3);
      await writeFile(path.join(dir, "bad.json"), "{");
      await expect(loadRecordedVectors(path.join(dir, "bad.json"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("searches an in-memory store by exact cosine, nearest first", async () => {
    const symbol = (symbolId: string, embeddingText: string) => ({
      symbolId,
      name: symbolId,
      qualifiedName: symbolId,
      kind: "function",
      filePath: `${symbolId}.ts`,
      embeddingText,
    });
    const embed: EmbedService = {
      async embed(texts) {
        const table: Record<string, number[]> = { near: [1, 0], far: [0, 1], zero: [0, 0] };
        return { vectors: texts.map((t) => table[t]!), model: "m", dimension: 2 };
      },
    };
    const store = await buildInMemorySymbolVectorStore(
      [symbol("b", "far"), symbol("a", "near"), symbol("z", "zero")],
      embed,
    );
    const hits = await store.search("p", [1, 0.1], 2);
    expect(hits.map((h) => h.metadata.symbolId)).toEqual(["a", "b"]);
    expect(hits[0]!.score).toBeGreaterThan(0.99);
  });
});
