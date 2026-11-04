/**
 * #1756 — the engine with the additive LLM edit-candidate check wired in.
 *
 * The hybrid side replays the #1036 capture of production's `HybridCodeSearch`
 * on Miniflux #4478; the check is the real `verifyEditCandidates` over a
 * provider double, with the real graph line check. Assertions read what the
 * engine PERSISTED.
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

const { executeImpactAnalysis, editVerifierNotice, InMemoryCodeGraphDataSource } =
  await import("./impact-analysis-engine.js");
const { verifyEditCandidates, graphLineCheck } = await import("./edit-candidate-verifier.js");

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

function modelSaying(answer: (pool: readonly SeedPoolFile[]) => string): AIProvider {
  let pool: readonly SeedPoolFile[] = [];
  const p = {
    key: "anthropic",
    model: "m",
    offline: false,
    chat: vi.fn(async () => ({ content: answer(pool), model: "m" })),
  } as unknown as AIProvider;
  return Object.assign(p, {
    setPool: (next: readonly SeedPoolFile[]) => {
      pool = next;
    },
  });
}

/** The engine's verifier dep over a model double and the capture's symbols as the graph. */
function verifierSaying(answer: (pool: readonly SeedPoolFile[]) => string) {
  const provider = modelSaying(answer) as AIProvider & {
    setPool(p: readonly SeedPoolFile[]): void;
  };
  const seen: Array<readonly SeedPoolFile[]> = [];
  const fn = vi.fn(
    async (input: {
      requirementText: string;
      pool: readonly SeedPoolFile[];
      projectId: string;
    }) => {
      seen.push(input.pool);
      provider.setPool(input.pool);
      return verifyEditCandidates({
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

describe("the engine with the edit-candidate check (#1756)", () => {
  it("off: the result is exactly today's, with no evidence and no summary sentence", async () => {
    vi.mocked(changeSeeds.resolveChangeSeeds).mockClear();
    const off = await run();
    // Off, the seeding is not even asked for its file pool.
    const asked = vi.mocked(changeSeeds.resolveChangeSeeds).mock.calls.map((c) => c[2]);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((deps) => !("filePoolSize" in deps))).toBe(true);
    expect("seedEvidence" in off.items[0]!).toBe(false);
    expect(String(off.analyses.get("ia")?.summary)).not.toContain("AI edit check");
  });

  it.each([
    ["an empty answer", () => "{}"],
    ["garbage", () => "<<garbage>>"],
    [
      "every file marked doubtful",
      (pool: readonly SeedPoolFile[]) =>
        JSON.stringify({ doubtful: pool.map((_, index) => ({ index, reason: "doubt" })) }),
    ],
  ])(
    "on: every deterministic edit candidate survives with its original score, after %s",
    async (_l, answer) => {
      const off = await run();
      const { fn } = verifierSaying(answer);
      const on = await run({ editCandidateVerifier: fn });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(direct(on.affected)).toEqual(direct(off.affected));
    },
  );

  it("on: shows the model the pool, deterministic files first, and records doubts as evidence", async () => {
    const { fn, seen } = verifierSaying((pool) =>
      JSON.stringify({ doubtful: [{ index: 0, reason: `${pool[0]!.filePath} is not touched` }] }),
    );
    vi.mocked(changeSeeds.resolveChangeSeeds).mockClear();
    const on = await run({ editCandidateVerifier: fn });
    expect(vi.mocked(changeSeeds.resolveChangeSeeds).mock.calls[0]![2]).toMatchObject({
      filePoolSize: 30,
    });
    const pool = seen[0]!;
    const editFiles = pool.filter((f) => f.editCandidate).map((f) => f.filePath);
    expect(pool.slice(0, editFiles.length).every((f) => f.editCandidate)).toBe(true);
    expect(pool.length).toBeGreaterThan(editFiles.length);
    expect(pool.length).toBeLessThanOrEqual(30);
    const evidence = impactSeedEvidenceSchema.parse(JSON.parse(String(on.items[0]!.seedEvidence)));
    expect(evidence.verifier).toEqual({ promoted: 0, doubtful: 1, droppedPromotions: 0 });
    expect(evidence.editCandidates[0]).toMatchObject({
      filePath: editFiles[0],
      channels: ["hybrid"],
      verdict: { kind: "doubtful" },
    });
    expect(String(on.analyses.get("ia")?.summary)).toContain(
      "The AI edit check added 0 files to the files to edit, each at a line checked against the code, and marked 1 file as doubtful (still listed).",
    );
  });

  it("on: persists a verified promotion as an edit candidate on its hybrid score, and counts a dropped one", async () => {
    const off = await run();
    let promotedFile = "";
    const { fn } = verifierSaying((pool) => {
      const i = pool.findIndex((f) => !f.editCandidate);
      const file = pool[i]!;
      promotedFile = file.filePath;
      const line = file.symbols[0]!.startLine!;
      return JSON.stringify({
        promote: [
          { index: i, line, reason: "It renders the page." },
          { index: i + 1, line: 99_999, reason: "nowhere" },
        ],
      });
    });
    const on = await run({ editCandidateVerifier: fn });
    // The rows are persisted by confidence, so the promotion sits among them: every
    // deterministic row is still there, unchanged, and exactly one row is new.
    for (const row of direct(off.affected)) expect(direct(on.affected)).toContainEqual(row);
    const added = direct(on.affected).filter((r) => r.filePath === promotedFile);
    expect(added).toHaveLength(1);
    expect(direct(on.affected)).toHaveLength(direct(off.affected).length + 1);
    const evidence = impactSeedEvidenceSchema.parse(JSON.parse(String(on.items[0]!.seedEvidence)));
    expect(evidence.verifier).toEqual({ promoted: 1, doubtful: 0, droppedPromotions: 1 });
    expect(evidence.editCandidates.at(-1)).toMatchObject({
      filePath: promotedFile,
      channels: ["edit-verifier"],
      verdict: { kind: "promoted", verified: true, reason: "It renders the page." },
    });
    expect(String(on.analyses.get("ia")?.summary)).toContain(
      "1 suggestion was dropped: the line it named was not in that file's code.",
    );
  });

  it("keeps the deterministic result when the verifier itself throws", async () => {
    const off = await run();
    const on = await run({ editCandidateVerifier: vi.fn().mockRejectedValue(new Error("boom")) });
    expect(direct(on.affected)).toEqual(direct(off.affected));
    expect("seedEvidence" in on.items[0]!).toBe(false);
  });

  it("an injected mapper does not run the check", async () => {
    const { fn } = verifierSaying(() => "{}");
    await run({ editCandidateVerifier: fn, mapRequirement: async () => [] });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("editVerifierNotice", () => {
  it("names the dropped suggestions only when there are some", () => {
    expect(editVerifierNotice({ promoted: 2, doubtful: 0, dropped: 0 })).toBe(
      "The AI edit check added 2 files to the files to edit, each at a line checked against the code, and marked 0 files as doubtful (still listed).",
    );
    expect(editVerifierNotice({ promoted: 1, doubtful: 1, dropped: 3 })).toMatch(
      /marked 1 file as doubtful \(still listed\)\. 3 suggestions were dropped/,
    );
  });
});
