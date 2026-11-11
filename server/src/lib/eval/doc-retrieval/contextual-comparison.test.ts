/**
 * Issue #2234 — the contextual-chunks comparison and its record/replay cache.
 *
 * `runContextualComparison` is driven with the DATABASE seams injected, exactly as
 * `runChunkSweep`'s orchestration test does: the corpus, chunking, span alignment
 * and scoring are the real code; the service is a fake whose ranking depends on
 * which arm it was built for.
 */
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({
  prisma: {},
  boundDatabaseUrl: "file:./dev.db",
  redactDatabaseUrl: (u: string) => u,
}));

import { chunkMarkdown } from "../../rag/chunker.js";
import type { ChunkContextGenerator } from "../../rag/contextual-chunks.js";
import type { ChunkArmSpec } from "./chunk-sweep.js";
import { cachedChunkContextGenerator, contextCacheKey, readContextCache } from "./context-cache.js";
import { loadDocRetrievalCorpus } from "./corpus.js";
import {
  relevantChunksForArm,
  renderContextualReport,
  runContextualComparison,
} from "./wired-harness.js";

describe("runContextualComparison", () => {
  /** The control ranks the answer SECOND; a contextual arm ranks it first. */
  const run = async () => {
    const corpus = await loadDocRetrievalCorpus();
    const built: string[] = [];
    let current: ChunkArmSpec | null = null;
    const chunksFor = (s: ChunkArmSpec, docId: string): number =>
      chunkMarkdown(corpus.docs.find((d) => d.id === docId)?.text ?? "", {
        chunkSize: s.chunkSize,
        overlap: s.overlap,
      }).length;
    const report = await runContextualComparison({
      embedder: { model: "fake-embedder" } as never,
      tmpRoot: os.tmpdir(),
      seed: 7,
      resamples: 200,
      modes: ["headings", "model"],
      seedDocuments: async (c) => new Map(c.docs.map((d) => [d.id, d.id])),
      makeService: (spec) => {
        current = spec;
        built.push(spec.id);
        return {
          async ingestDocument(documentId: string) {
            return { status: "ready", chunkCount: chunksFor(spec, documentId) };
          },
          async search(_projectId: string, question: string) {
            const q = corpus.queries.find((x) => x.question === question);
            const rel = q ? relevantChunksForArm(corpus, spec).get(q.id)?.text : undefined;
            const answer = rel ?? "";
            return {
              hits: (spec.control ? ["noise", answer] : [answer]).map((text) => ({ text })),
            };
          },
        };
      },
      resetIndex: async () => {},
      countPersisted: async () =>
        corpus.docs.reduce((n, d) => n + chunksFor(current as ChunkArmSpec, d.id), 0),
      log: () => {},
    });
    return { report, built, corpus };
  };

  it("runs the off control and then one arm per mode, all at the control's chunking", async () => {
    const { report, built, corpus } = await run();
    expect(built).toEqual(["size-2048", "contextual-headings", "contextual-model"]);
    expect(report.arms.map((a) => a.mode)).toEqual(["headings", "model"]);
    expect(report.control.spec.control).toBe(true);
    for (const { comparison } of report.arms) {
      expect(comparison.chunkSize).toBe(report.control.spec.chunkSize);
      expect(comparison.overlap).toBe(report.control.spec.overlap);
      expect(comparison.sensitiveCount).toBe(corpus.queries.length);
    }
  }, 60_000);

  it("scores a ranking gain as a positive delta against the control, and renders it", async () => {
    const { report } = await run();
    for (const { comparison } of report.arms) {
      expect(comparison.all.paired.meanDelta).toBeGreaterThan(0);
      expect(comparison.ndcgAt10).toBeGreaterThan(report.control.metrics.ndcgAtK[10] ?? 0);
    }
    const md = renderContextualReport(report);
    expect(md).toContain("| `off` (control) |");
    expect(md).toMatch(/\| `headings` \| [0-9.]+ \| [0-9.]+ \| [0-9.]+ \| \+0\.\d{3} \|/);
    expect(md).toContain("| `model` |");
  }, 60_000);
});

describe("cachedChunkContextGenerator", () => {
  const input = (chunks: string[]) => ({ projectId: "p", document: "D", title: "T", chunks });

  it("calls the model only for unrecorded chunks, records successes and persists", async () => {
    const cache: Record<string, string> = { [contextCacheKey("D", "a")]: "recorded a" };
    const inner = vi.fn<ChunkContextGenerator>(async ({ chunks }) =>
      chunks.map((c) => (c === "c" ? null : `new ${c}`)),
    );
    const persist = vi.fn(async () => {});
    const gen = cachedChunkContextGenerator(inner, cache, persist);

    expect(await gen(input(["a", "b", "c"]))).toEqual(["recorded a", "new b", null]);
    expect(inner).toHaveBeenCalledWith(input(["b", "c"]));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(cache[contextCacheKey("D", "b")]).toBe("new b");
    // A failed chunk is not recorded, so the next run retries only it.
    expect(contextCacheKey("D", "c") in cache).toBe(false);
    await gen(input(["a", "b", "c"]));
    expect(inner).toHaveBeenLastCalledWith(input(["c"]));
  });

  it("does not call the model or persist when everything is recorded", async () => {
    const cache = { [contextCacheKey("D", "a")]: "x" };
    const inner = vi.fn<ChunkContextGenerator>();
    const persist = vi.fn(async () => {});
    expect(await cachedChunkContextGenerator(inner, cache, persist)(input(["a"]))).toEqual(["x"]);
    expect(inner).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("keys on the document as well as the chunk", () => {
    expect(contextCacheKey("D1", "a")).not.toBe(contextCacheKey("D2", "a"));
  });

  it("reads a missing cache file as empty and a written one back", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "metis-2234-cache-"));
    try {
      const file = path.join(dir, "ctx.json");
      expect(await readContextCache(file)).toEqual({});
      await writeFile(file, JSON.stringify({ k: "v" }), "utf8");
      expect(await readContextCache(file)).toEqual({ k: "v" });
      await writeFile(file, "{", "utf8");
      await expect(readContextCache(file)).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe("{");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
