/**
 * Epic #780 / Issue #797 — unit tests for the REALISED-path eval runner.
 *
 * These do not measure retrieval quality (that needs real weights and is what
 * `pnpm eval:embed-retrieval --wired` is for). They assert the property that makes
 * the runner worth trusting AT ALL: that it really does go through the production
 * write + read path, so a future refactor cannot quietly detach it and leave the
 * eval measuring a harness again — which is precisely the #797 defect.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadEmbedRetrievalCorpus } from "./corpus.js";
import { createCorpusMetadataRepo, runWiredArm, runWiredSweep } from "./wired-runner.js";
import * as symbolService from "../../code-graph/symbol-embedding-service.js";
import * as searcherModule from "../../code-graph/project-code-searcher.js";
import { __resetReindexLeaseBackend } from "../../rag/reindex-lease.js";
import type { EmbedFn } from "./runner.js";

beforeEach(() => {
  // #876 — the wired runner takes the project's reindex lease. This suite runs entirely
  // in-memory, so that lease must resolve to the no-op backend; an ambient Postgres
  // `DATABASE_URL` (a developer dogfooding on Postgres) would otherwise send it to a real
  // `PostgresReindexLeaseBackend` and fail on `$executeRawUnsafe`.
  delete process.env.DATABASE_URL;
  __resetReindexLeaseBackend();
});

/** Deterministic, dimension-stable embedder — no weights, no network. */
const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const v = [0, 0, 0, 0];
    for (let i = 0; i < t.length; i += 1) v[i % 4] += t.charCodeAt(i) % 13;
    return v;
  });

describe("createCorpusMetadataRepo", () => {
  it("stands in for the CodeSymbolEmbedding rows ingest would have written", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    const repo = createCorpusMetadataRepo(corpus);
    const listed = await repo.list(corpus.projectId);

    expect(listed).toHaveLength(corpus.docs.length);
    // Every row starts PENDING, exactly as `ingestCodeGraph` writes it — the embed
    // job is what moves it to a model tag.
    expect(listed.every((r) => r.embeddingModel === "")).toBe(true);
    // And carries the PRODUCTION index-time text, not some eval-only rendering.
    expect(listed[0].text).toBe(corpus.docs.find((d) => d.id === listed[0].symbolId)?.text);
  });

  it("records the model tag when the pipeline tags a row", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    const repo = createCorpusMetadataRepo(corpus);
    const [first] = await repo.list(corpus.projectId);

    await repo.tag(corpus.projectId, [
      { symbolId: first.symbolId, contentHash: "h", embeddingModel: "m" },
    ]);

    const after = await repo.list(corpus.projectId);
    expect(after.find((r) => r.symbolId === first.symbolId)).toMatchObject({
      contentHash: "h",
      embeddingModel: "m",
    });
  });
});

describe("runWiredArm", () => {
  it("scores every query through the production embed + store path", async () => {
    const corpus = await loadEmbedRetrievalCorpus();

    // The load-bearing assertion: the runner drives the REAL production entry
    // points. If a refactor makes it build its own store again, these spies stop
    // firing and this test fails — which is the whole point of it existing.
    const embedSpy = vi.spyOn(symbolService, "embedProjectSymbols");
    const readSpy = vi.spyOn(symbolService, "createSymbolVectorStore");

    const result = await runWiredArm("test-arm", corpus, fakeEmbed, "test-model");

    expect(embedSpy).toHaveBeenCalledWith(corpus.projectId, expect.anything());
    expect(readSpy).toHaveBeenCalled();

    expect(result.armId).toBe("test-arm");
    expect(result.embedded).toBe(corpus.docs.length);
    expect(result.docCount).toBe(corpus.docs.length);
    expect(result.queryCount).toBe(corpus.queries.length);
    expect(result.perQuery).toHaveLength(corpus.queries.length);

    // Metrics are well-formed; their VALUE is a measurement, not an assertion —
    // a 4-dim toy embedder says nothing about the real model.
    for (const channel of [result.hybrid, result.vector]) {
      expect(channel.ndcgAtK[10]).toBeGreaterThanOrEqual(0);
      expect(channel.ndcgAtK[10]).toBeLessThanOrEqual(1);
    }

    embedSpy.mockRestore();
    readSpy.mockRestore();
  }, 120_000);

  it("goes through createDefaultCodeSearcher — the seam production actually calls", async () => {
    // PR #803 review (M3). The previous version built its own `HybridCodeSearch`, so it
    // imitated production's ranking instead of using it: the searcher's own weights,
    // result mapping and limit handling were never exercised, and the eval could drift
    // from the tool without a single test going red. Spying on the FACTORY is what makes
    // "the wired eval measures production" a checkable claim rather than a comment.
    const corpus = await loadEmbedRetrievalCorpus();
    const searcherSpy = vi.spyOn(searcherModule, "createDefaultCodeSearcher");

    await runWiredArm("test-arm", corpus, fakeEmbed, "test-model");

    expect(searcherSpy).toHaveBeenCalledTimes(1);
    // …and it is handed the REAL vector store + the corpus symbol index, not a stub.
    const deps = searcherSpy.mock.calls[0][0];
    expect(deps?.vectorStore).toBeDefined();
    expect(deps?.symbolIndex?.getSymbolsByIds).toBeDefined();

    searcherSpy.mockRestore();
  }, 120_000);

  it("FAILS LOUDLY if the production write path stops being exercised", async () => {
    // The tripwire, asserted on an observable. An embedder that returns no vectors
    // leaves the production namespace empty — which is exactly what a refactor that
    // detached the eval from the real store would look like, and it must not be
    // allowed to score as a quiet zero.
    const corpus = await loadEmbedRetrievalCorpus();
    const noVectors: EmbedFn = async () => [];

    await expect(runWiredArm("dead-arm", corpus, noVectors, "test-model")).rejects.toThrow(
      /production write path is not being exercised/,
    );
  }, 120_000);
});

describe("runWiredSweep", () => {
  it("embeds once and scores every weighting off the same wired store", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    const embedSpy = vi.spyOn(symbolService, "embedProjectSymbols");

    const report = await runWiredSweep(corpus, fakeEmbed, "test-model", [
      { bm25Weight: 0.4, vectorWeight: 0.6 },
      { bm25Weight: 0.15, vectorWeight: 0.85 },
    ]);

    // Vectors do not depend on the fusion weights: re-embedding per setting would burn
    // the ONNX time N times over to rebuild an identical store.
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(report.rows).toHaveLength(2);
    expect(report.incumbent.weights.bm25Weight).toBe(0.4);
    for (const r of report.rows) {
      expect(r.hybridNdcg10).toBeGreaterThanOrEqual(0);
      expect(r.exactNameCount).toBeGreaterThan(0);
    }

    embedSpy.mockRestore();
  }, 180_000);
});
