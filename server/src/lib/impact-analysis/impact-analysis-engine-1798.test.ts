/**
 * #1798 — the engine with the LLM re-order of the edit candidates wired in.
 *
 * The hybrid side replays the #1036 capture of production's `HybridCodeSearch`
 * on Miniflux #4478 (as the #1756 engine test does); the re-order is the real
 * `rerankEditCandidates` over a provider double, with the real graph line
 * check. Assertions read what the engine PERSISTED.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { impactSeedEvidenceSchema } from "@metis/shared";
import type { AIProvider } from "../ai/types.js";
import type { GraphSymbol } from "../code-graph/query-service.js";
import type { SeedPoolFile, SeedSearchHit, SeedSymbolRow } from "./change-seeds.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, "__fixtures__", name), "utf8");
const ISSUE_4478 = read("miniflux-4478.md");
const CAPTURE = JSON.parse(read("miniflux-4478-hits.json")) as {
  queries: { query: string; hits: SeedSearchHit[] }[];
  symbols: SeedSymbolRow[];
};

vi.mock("../code-graph/project-code-searcher.js", () => ({
  createDefaultCodeSearcher: () => ({
    search: async (query: string) => CAPTURE.queries.find((q) => q.query === query)?.hits ?? [],
  }),
  createRunScopedSymbolIndex: () => ({}),
}));

// Pass-through, so a test can read which seeding options the engine asked for.
vi.mock("./change-seeds.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./change-seeds.js")>();
  return { ...actual, resolveChangeSeeds: vi.fn(actual.resolveChangeSeeds) };
});
const changeSeeds = await import("./change-seeds.js");

const { executeImpactAnalysis, editRerankNotice, InMemoryCodeGraphDataSource } =
  await import("./impact-analysis-engine.js");
const { rerankEditCandidates } = await import("./edit-candidate-reranker.js");
const { graphLineCheck } = await import("./edit-candidate-verifier.js");

const graph = new InMemoryCodeGraphDataSource(
  CAPTURE.symbols.map((s): GraphSymbol => ({
    id: s.id,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    filePath: s.filePath,
    language: s.language,
    startLine: s.startLine ?? 1,
    endLine: s.endLine ?? 1,
  })),
  [],
);

function prismaMock() {
  const analyses = new Map<string, Record<string, unknown>>([
    ["ia", { id: "ia", sourceText: ISSUE_4478, documentId: null }],
  ]);
  const items: Record<string, unknown>[] = [];
  const affected: Record<string, unknown>[] = [];
  const prisma = {
    impactAnalysis: {
      findFirst: async ({ where }: { where: { id: string } }) => analyses.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        analyses.set(where.id, { ...analyses.get(where.id), ...data });
        return analyses.get(where.id);
      },
    },
    impactItem: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        items.push(data);
        return { id: `item-${items.length}`, ...data };
      },
    },
    impactAffectedSymbol: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        affected.push(...data.map((d) => ({ ...d })));
        return { count: data.length };
      },
    },
    impactAffectedTable: { createMany: async () => ({ count: 0 }) },
    knowledgeChunk: { findMany: async () => [] },
    quarantineChunk: { findMany: async () => [] },
    document: {},
    codeSymbol: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        CAPTURE.symbols.filter((s) => where.id.in.includes(s.id)),
    },
    codeEdge: { findMany: async () => [] },
  };
  return { prisma, analyses, items, affected };
}

/** The engine's re-order dep over a model double that answers from the pool it is shown. */
function rerankerSaying(answer: (pool: readonly SeedPoolFile[]) => string) {
  const seen: Array<readonly SeedPoolFile[]> = [];
  const fn = vi.fn(
    async (input: {
      requirementText: string;
      pool: readonly SeedPoolFile[];
      projectId: string;
    }) => {
      seen.push(input.pool);
      const provider = {
        key: "anthropic",
        model: "m",
        offline: false,
        chat: vi.fn(async () => ({ content: answer(input.pool), model: "m" })),
      } as unknown as AIProvider;
      return rerankEditCandidates({
        requirementText: input.requirementText,
        pool: input.pool,
        provider,
        lineCheck: graphLineCheck(
          async (files) => CAPTURE.symbols.filter((s) => files.includes(s.filePath)),
          input.projectId,
        ),
      });
    },
  );
  return { fn, seen };
}

/** The pool files the search ranked LOWEST, named first, each at its first symbol's line. */
const lastFirst = (n: number) => (pool: readonly SeedPoolFile[]) =>
  JSON.stringify({
    order: pool
      .map((f, index) => ({ index, line: f.symbols.find((s) => s.startLine)?.startLine ?? 0 }))
      .filter((p) => p.line > 0 && !pool[p.index]!.editCandidate)
      .slice(-n)
      .reverse()
      .map((p) => ({ ...p, reason: "It renders the page." })),
  });

const run = async (extra: Record<string, unknown> = {}) => {
  const m = prismaMock();
  await executeImpactAnalysis("ia", ["p1"], {
    prisma: m.prisma as never,
    dataSourceFor: () => graph,
    includeSchemaImpact: false,
    ...extra,
  });
  return m;
};

const direct = (rows: Record<string, unknown>[]) =>
  rows.filter((r) => r.relation === "direct" && r.depth === 0);
const evidenceOf = (m: Awaited<ReturnType<typeof run>>) =>
  impactSeedEvidenceSchema.parse(JSON.parse(String(m.items[0]!.seedEvidence)));

describe("the engine with the edit re-order (#1798)", () => {
  it("off: the seeding is not asked for its pool, and the summary says nothing", async () => {
    vi.mocked(changeSeeds.resolveChangeSeeds).mockClear();
    const off = await run();
    const asked = vi.mocked(changeSeeds.resolveChangeSeeds).mock.calls.map((c) => c[2]);
    expect(asked.every((deps) => !("filePoolSize" in deps))).toBe(true);
    expect(String(off.analyses.get("ia")?.summary)).not.toContain("AI re-order");
  });

  it.each([
    ["an empty answer", () => "{}"],
    ["garbage", () => "<<garbage>>"],
  ])("on: the deterministic edit candidates are exactly today's after %s", async (_l, answer) => {
    const off = await run();
    const { fn } = rerankerSaying(answer);
    const on = await run({ editCandidateReranker: fn });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(direct(on.affected)).toEqual(direct(off.affected));
  });

  it("on: moves the model's checked picks to the head, keeps every deterministic candidate, and says so", async () => {
    const off = await run();
    const { fn, seen } = rerankerSaying(lastFirst(3));
    vi.mocked(changeSeeds.resolveChangeSeeds).mockClear();
    const on = await run({ editCandidateReranker: fn });
    expect(vi.mocked(changeSeeds.resolveChangeSeeds).mock.calls[0]![2]).toMatchObject({
      filePoolSize: 30,
    });
    // Every deterministic row is still persisted, unchanged.
    for (const row of direct(off.affected)) expect(direct(on.affected)).toContainEqual(row);
    const pool = seen[0]!;
    const picked = JSON.parse(lastFirst(3)(pool)) as { order: Array<{ index: number }> };
    const pickedFiles = picked.order.map((p) => pool[p.index]!.filePath);
    const evidence = evidenceOf(on);
    expect(evidence.reranker).toMatchObject({ droppedPicks: 0 });
    expect(evidence.reranker!.moved).toBeGreaterThan(0);
    // The fused head starts with the model's first pick.
    expect(evidence.editCandidates[0]).toMatchObject({
      filePath: pickedFiles[0],
      channels: ["edit-reranker"],
      modelRank: 1,
      verdict: { kind: "promoted", verified: true, reason: "It renders the page." },
    });
    const added = direct(on.affected).length - direct(off.affected).length;
    expect(added).toBeGreaterThan(0);
    expect(String(on.analyses.get("ia")?.summary)).toMatch(
      /The AI re-order ranked \d+ files? higher in the order of the files to edit, \d+ of them not picked by the search/,
    );
  });

  it("runs after the #1756 check, over the same pool, when both are on", async () => {
    const order: string[] = [];
    const { fn } = rerankerSaying(() => {
      order.push("rerank");
      return "{}";
    });
    const verifier = vi.fn(async () => {
      order.push("verify");
      return { applied: false, promoted: [], doubtful: [], droppedPromotions: 0, namedFiles: [] };
    });
    await run({ editCandidateVerifier: verifier, editCandidateReranker: fn });
    expect(order).toEqual(["verify", "rerank"]);
  });

  it("keeps the deterministic result when the re-order itself throws", async () => {
    const off = await run();
    const on = await run({ editCandidateReranker: vi.fn().mockRejectedValue(new Error("boom")) });
    expect(direct(on.affected)).toEqual(direct(off.affected));
    expect("seedEvidence" in on.items[0]!).toBe(false);
  });
});

describe("editRerankNotice", () => {
  it("says nothing moved, and that every search pick is still listed", () => {
    expect(editRerankNotice({ moved: 0, promoted: 0, dropped: 0 })).toBe(
      "The AI re-order changed no file's place in the order of the files to edit; every file the search picked is still listed.",
    );
  });

  it("names the moves, the files the search had not picked, and the drops", () => {
    expect(editRerankNotice({ moved: 2, promoted: 0, dropped: 0 })).toBe(
      "The AI re-order ranked 2 files higher in the order of the files to edit; the list shown keeps its own sort (depth, then confidence), and every file the search picked is still listed.",
    );
    expect(editRerankNotice({ moved: 1, promoted: 1, dropped: 2 })).toBe(
      "The AI re-order ranked 1 file higher in the order of the files to edit, 1 of them not picked by the search " +
        "(each at a line checked against the code); the list shown keeps its own sort (depth, then confidence), and every file the search picked is still listed. " +
        "2 suggestions were dropped because they could not be checked: a line outside every function or type of that file, " +
        "a file not in the list, an unreadable entry, or more than 10 suggestions.",
    );
    expect(editRerankNotice({ moved: 0, promoted: 0, dropped: 1 })).toMatch(
      /1 suggestion was dropped because it could not be checked/,
    );
  });
});
