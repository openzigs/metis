/**
 * Issue #1182 — `chunkerIdentity` coverage: a store holding two chunker
 * generations must stop being invisible.
 *
 * ## What was broken
 *
 * `coverageReport()` and `deploymentCoverage()` grouped on `embeddingModel`
 * alone, which records how a chunk's text was VECTORISED and says nothing about
 * how it was CUT. #1178 fixed a chunker that had not tiled its input for eight
 * months — every boundary moved, no parameter changed — so a corpus ingested
 * before the fix and one ingested after are different chunkings that every
 * existing guard reported as identical. `pnpm embeddings:migrate status` printed
 * "Up to date." and exited 0 over a corpus missing content.
 *
 * ## Main-vs-fix evidence
 *
 * Run against pre-#1182 `main`, every test below fails at the first assertion
 * that reads a chunker field: `coverageReport()` returns no `chunkerCounts`,
 * `needsReingest` or `currentChunkerIdentity` at all.
 *
 * ## The invariant these tests exist to defend
 *
 * `needsReindex` and `needsReingest` are INDEPENDENT. The remedies differ —
 * `reindexProject` re-embeds stored chunk text and never re-chunks, so it cannot
 * repair a boundary — and merging them would let `reindex --all` claim work it
 * cannot do.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KnowledgeService } from "./knowledge-service.js";
import type { Embedder } from "./embedder.js";
import type { VectorStore } from "./vector-store.js";
import { DOCSGEN_CHUNKER_IDENTITY } from "../docs-gen/rag-ingest.js";

const MODEL = "Alibaba-NLP/gte-modernbert-base";
const OTHER_MODEL = "Xenova/bge-small-en-v1.5";
/** What the shipped 2048/256 configuration produces today. */
const CURRENT_CHUNKER = "doc:v3:2048/256";

interface Row {
  id: string;
  projectId: string;
  embeddingModel: string;
  /** `null` is the pre-#1182 generation, exactly as the column stores it. */
  chunkerIdentity: string | null;
}

let rows: Row[] = [];

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  if (typeof where.projectId === "string" && row.projectId !== where.projectId) return false;
  return true;
}

/** A `groupBy` faithful enough to distinguish the three `by:` shapes in use. */
function groupBy(args: {
  by: string[];
  where?: Record<string, unknown>;
}): Promise<Array<Record<string, unknown>>> {
  const counts = new Map<string, { key: Record<string, unknown>; n: number }>();
  for (const r of rows) {
    if (!matches(r, args.where)) continue;
    const key: Record<string, unknown> = {};
    for (const field of args.by) key[field] = (r as unknown as Record<string, unknown>)[field];
    const k = JSON.stringify(key);
    const existing = counts.get(k);
    if (existing) existing.n += 1;
    else counts.set(k, { key, n: 1 });
  }
  return Promise.resolve(
    [...counts.values()].map(({ key, n }) => ({ ...key, _count: { _all: n } })),
  );
}

vi.mock("../code-graph/symbol-embedding-service.js", () => ({
  getSymbolEmbeddingsPort: () => ({
    coverage: async () => ({ totalSymbols: 0, modelCounts: {} }),
    deploymentCoverage: async () => new Map(),
    dropProject: async () => {},
    isBusy: () => false,
  }),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    knowledgeChunk: {
      groupBy: (...a: unknown[]) => groupBy(...(a as [never])),
    },
  },
}));

function makeService(): KnowledgeService {
  const embedder = {
    model: MODEL,
    dimension: 768,
    embed: async () => {
      throw new Error("coverage must not embed");
    },
  } as unknown as Embedder;
  return new KnowledgeService({ embedder, vectorStore: {} as VectorStore });
}

beforeEach(() => {
  rows = [];
  vi.clearAllMocks();
});

describe("coverageReport — issue #1182 chunker generations", () => {
  it("reports untagged rows as a generation, not as missing data", async () => {
    rows = [
      { id: "a", projectId: "p1", embeddingModel: MODEL, chunkerIdentity: null },
      { id: "b", projectId: "p1", embeddingModel: MODEL, chunkerIdentity: null },
      { id: "c", projectId: "p1", embeddingModel: MODEL, chunkerIdentity: CURRENT_CHUNKER },
    ];
    const report = await makeService().coverageReport("p1");

    expect(report.currentChunkerIdentity).toBe(CURRENT_CHUNKER);
    // NULL collapses to "" — the same convention #797 uses for a pending symbol.
    expect(report.chunkerCounts).toEqual({ "": 2, [CURRENT_CHUNKER]: 1 });
    expect(report.matchingChunkerChunks).toBe(1);
    expect(report.needsReingest).toBe(true);
  });

  it("is clean when every chunk carries the active generation", async () => {
    rows = [
      { id: "a", projectId: "p1", embeddingModel: MODEL, chunkerIdentity: CURRENT_CHUNKER },
      { id: "b", projectId: "p1", embeddingModel: MODEL, chunkerIdentity: CURRENT_CHUNKER },
    ];
    const report = await makeService().coverageReport("p1");

    expect(report.needsReingest).toBe(false);
    expect(report.matchingChunkerChunks).toBe(2);
  });

  it("reports no drift for an EMPTY project — nothing indexed is not a problem", async () => {
    const report = await makeService().coverageReport("p-empty");
    expect(report.chunkerCounts).toEqual({});
    expect(report.needsReingest).toBe(false);
  });

  it("flags chunker drift while the MODEL half is completely clean", async () => {
    // The case the issue exists for: nothing else in the report says anything is
    // wrong, so before #1182 this state was indistinguishable from a healthy one.
    rows = [{ id: "a", projectId: "p1", embeddingModel: MODEL, chunkerIdentity: null }];
    const report = await makeService().coverageReport("p1");

    expect(report.needsReindex).toBe(false);
    expect(report.needsReingest).toBe(true);
  });

  it("flags model drift while the CHUNKER half is clean — the two are independent", async () => {
    rows = [
      { id: "a", projectId: "p1", embeddingModel: OTHER_MODEL, chunkerIdentity: CURRENT_CHUNKER },
    ];
    const report = await makeService().coverageReport("p1");

    expect(report.needsReindex).toBe(true);
    expect(report.needsReingest).toBe(false);
  });

  /**
   * The blocking defect PR #1182's review panel found. `docs-gen/rag-ingest.ts` is a
   * SECOND `knowledge_chunks` writer with its own 1,500-character chunker. Counting
   * its rows as drift produced a mismatch no remedy could clear — re-running
   * generation re-runs that same foreign chunker — so `embeddings:migrate status`
   * would have sat at exit 3 forever. Measured on the live dev database at the time:
   * 103 of 1,415 rows, across 2 of 3 projects.
   */
  it("does NOT count another producer's chunks as drift", async () => {
    rows = [
      { id: "a", projectId: "p1", embeddingModel: MODEL, chunkerIdentity: CURRENT_CHUNKER },
      {
        id: "b",
        projectId: "p1",
        embeddingModel: MODEL,
        chunkerIdentity: DOCSGEN_CHUNKER_IDENTITY,
      },
    ];
    const report = await makeService().coverageReport("p1");

    expect(report.needsReingest).toBe(false);
    // Still REPORTED — an operator can see the corpus is mixed — just not counted
    // as work outstanding.
    expect(report.chunkerCounts).toEqual({
      [CURRENT_CHUNKER]: 1,
      [DOCSGEN_CHUNKER_IDENTITY]: 1,
    });
    // And it is not silently folded into the matching count either.
    expect(report.matchingChunkerChunks).toBe(1);
  });

  it("a project of ONLY foreign chunks is clean, not 100% drifted", async () => {
    rows = [
      {
        id: "a",
        projectId: "p1",
        embeddingModel: MODEL,
        chunkerIdentity: DOCSGEN_CHUNKER_IDENTITY,
      },
    ];
    const report = await makeService().coverageReport("p1");
    expect(report.needsReingest).toBe(false);
  });

  it("still flags a genuine drift sitting alongside foreign chunks", async () => {
    // The foreign exclusion must not become a blanket amnesty.
    rows = [
      {
        id: "a",
        projectId: "p1",
        embeddingModel: MODEL,
        chunkerIdentity: DOCSGEN_CHUNKER_IDENTITY,
      },
      { id: "b", projectId: "p1", embeddingModel: MODEL, chunkerIdentity: null },
    ];
    const report = await makeService().coverageReport("p1");
    expect(report.needsReingest).toBe(true);
  });

  it("scopes the chunker groupBy to the requested project", async () => {
    rows = [
      { id: "a", projectId: "p1", embeddingModel: MODEL, chunkerIdentity: CURRENT_CHUNKER },
      { id: "b", projectId: "p2", embeddingModel: MODEL, chunkerIdentity: null },
    ];
    const report = await makeService().coverageReport("p1");

    // p2's untagged row must not leak into p1's verdict.
    expect(report.chunkerCounts).toEqual({ [CURRENT_CHUNKER]: 1 });
    expect(report.needsReingest).toBe(false);
  });
});

describe("deploymentCoverage — issue #1182 chunker generations", () => {
  it("splits generations per project and deployment-wide", async () => {
    rows = [
      { id: "a", projectId: "p-old", embeddingModel: MODEL, chunkerIdentity: null },
      { id: "b", projectId: "p-old", embeddingModel: MODEL, chunkerIdentity: null },
      { id: "c", projectId: "p-new", embeddingModel: MODEL, chunkerIdentity: CURRENT_CHUNKER },
    ];
    const report = await makeService().deploymentCoverage();

    expect(report.currentChunkerIdentity).toBe(CURRENT_CHUNKER);
    expect(report.chunkerCounts).toEqual({ "": 2, [CURRENT_CHUNKER]: 1 });
    expect(report.projectsNeedingReingest).toBe(1);

    const old = report.projects.find((p) => p.projectId === "p-old");
    expect(old?.needsReingest).toBe(true);
    expect(old?.matchingChunkerChunks).toBe(0);
    expect(old?.chunkerCounts).toEqual({ "": 2 });

    const fresh = report.projects.find((p) => p.projectId === "p-new");
    expect(fresh?.needsReingest).toBe(false);
  });

  it("counts a project needing BOTH remedies once in each tally, not once overall", async () => {
    rows = [
      { id: "a", projectId: "p-both", embeddingModel: OTHER_MODEL, chunkerIdentity: null },
      {
        id: "b",
        projectId: "p-model",
        embeddingModel: OTHER_MODEL,
        chunkerIdentity: CURRENT_CHUNKER,
      },
      { id: "c", projectId: "p-chunk", embeddingModel: MODEL, chunkerIdentity: null },
    ];
    const report = await makeService().deploymentCoverage();

    expect(report.projectsNeedingReindex).toBe(2); // p-both, p-model
    expect(report.projectsNeedingReingest).toBe(2); // p-both, p-chunk
  });

  it("reports zero of both for an empty deployment", async () => {
    const report = await makeService().deploymentCoverage();
    expect(report.projectsNeedingReingest).toBe(0);
    expect(report.chunkerCounts).toEqual({});
  });
});
