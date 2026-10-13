/**
 * PR #1126 review — impact seeding asks the searcher for up to 120 hits per
 * query and reads an id and a score off each. Since #1072 the default searcher
 * also read up to 120 stored embedding texts per query to cut snippets nobody
 * rendered. Seeding turns that read off; a caller that renders snippets keeps it.
 *
 * Driven through the module-global client on purpose: that is the one path on
 * which the searcher builds its default snippet lookup (an injected client gets
 * a run-scoped index, which never had one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const symbolFindMany = vi.hoisted(() => vi.fn());
const symbolAggregate = vi.hoisted(() => vi.fn());
const graphAggregate = vi.hoisted(() => vi.fn());
const embeddingFindMany = vi.hoisted(() => vi.fn());

vi.mock("../prisma.js", () => ({
  prisma: {
    codeSymbol: { findMany: symbolFindMany, aggregate: symbolAggregate },
    codeGraph: { aggregate: graphAggregate },
    codeSymbolEmbedding: { findMany: embeddingFindMany },
  },
}));

import {
  __resetSymbolIndexCache,
  createDefaultCodeSearcher,
} from "../code-graph/project-code-searcher.js";
import { prisma } from "../prisma.js";
import { defaultSeedChange } from "./impact-analysis-engine.js";

const ROWS = [
  {
    id: "s1",
    name: "MarkAllAsRead",
    kind: "function",
    language: "go",
    qualifiedName: "storage/entry.go::MarkAllAsRead",
    filePath: "storage/entry.go",
    startLine: 1,
    endLine: 9,
    projectId: "p1",
    signature: "func MarkAllAsRead() error",
    docComment: null,
    package: "storage",
  },
];

const noVectors = {
  vectorStore: { search: async () => [] },
  embedService: { embed: async () => ({ vectors: [], dimension: 0, model: "none" }) },
};

const change = {
  requirementId: null,
  title: "mark all as read",
  body: "",
  changeType: "added" as const,
  bodyDelta: 1,
};

beforeEach(() => {
  symbolFindMany.mockImplementation(async ({ where }: { where: { id?: { in: string[] } } }) =>
    ROWS.filter((r) => !where.id || where.id.in.includes(r.id)),
  );
  symbolAggregate.mockResolvedValue({ _count: { _all: 1 }, _max: { createdAt: new Date(1_000) } });
  graphAggregate.mockResolvedValue({ _max: { lastIndexedAt: new Date(5_000) } });
  embeddingFindMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  __resetSymbolIndexCache();
});

describe("impact seeding does not read body snippets (PR #1126 review)", () => {
  it("finds its seeds on the production client without reading one embedding text", async () => {
    const seeds = await defaultSeedChange(prisma as never, noVectors as never)(change, "p1");
    expect(seeds.editCandidates.map((m) => m.qualifiedName)).toEqual([
      "storage/entry.go::MarkAllAsRead",
    ]);
    expect(embeddingFindMany).not.toHaveBeenCalled();
  });

  it("the control: a default searcher on the same client DOES read them", async () => {
    const hits = await createDefaultCodeSearcher(noVectors as never).search(
      "mark all as read",
      "p1",
    );
    expect(hits.map((h) => h.symbolId)).toEqual(["s1"]);
    expect(embeddingFindMany).toHaveBeenCalledTimes(1);
  });

  it("a caller can still hand seeding a lookup of its own", async () => {
    const resolve = vi.fn().mockResolvedValue(new Map());
    await defaultSeedChange(prisma as never, { ...noVectors, snippetLookup: { resolve } } as never)(
      change,
      "p1",
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
