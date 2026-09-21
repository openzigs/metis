/**
 * SAS-awareness regression tests for the holistic synthesizer's module filter
 * (`loadModules`).
 *
 * Bug: SAS programs emit ONLY `function` symbols (macros, DATA steps, PROC
 * steps) and never class/interface symbols. The default documentable-module
 * filter required ≥1 class/interface OR ≥4 functions in the normal branch, and
 * class/interface ONLY in the >200-symbol mega-module branch — so every SAS
 * directory was dropped and the synthesizer silently returned an empty document
 * marked `ready`.
 *
 * These tests drive the ONLINE synthesis path (provider + prisma mocked) and
 * assert that:
 *   1. A SAS-only module group (≥3 SAS `function` symbols, 0 classes) produces a
 *      NON-empty module set in the normal branch.
 *   2. The same holds in the >200-symbol mega-module (per-file split) branch.
 *   3. When the final module set is empty BUT raw symbols existed, a degraded
 *      warning is emitted (status would be "degraded", not silent "ready").
 *   4. The genuinely-zero-symbols case stays a clean empty doc with NO warnings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk } from "../ai/types.js";

// ── prisma mock ─────────────────────────────────────────────────────────
const mockPrisma = {
  project: { findUnique: vi.fn() },
  codeSymbol: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
  codeGraph: { findFirst: vi.fn(), findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  repoConnection: { findFirst: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn() },
};

vi.mock("../prisma.js", () => ({
  prisma: {
    project: { findUnique: (...a: unknown[]) => mockPrisma.project.findUnique(...a) },
    codeSymbol: {
      count: (...a: unknown[]) => mockPrisma.codeSymbol.count(...a),
      groupBy: (...a: unknown[]) => mockPrisma.codeSymbol.groupBy(...a),
      findMany: (...a: unknown[]) => mockPrisma.codeSymbol.findMany(...a),
    },
    codeGraph: {
      findFirst: (...a: unknown[]) => mockPrisma.codeGraph.findFirst(...a),
      findMany: (...a: unknown[]) => mockPrisma.codeGraph.findMany(...a),
    },
    finding: { findMany: (...a: unknown[]) => mockPrisma.finding.findMany(...a) },
    repoConnection: { findFirst: (...a: unknown[]) => mockPrisma.repoConnection.findFirst(...a) },
    docsGenFactCache: {
      findUnique: (...a: unknown[]) => mockPrisma.docsGenFactCache.findUnique(...a),
      upsert: (...a: unknown[]) => mockPrisma.docsGenFactCache.upsert(...a),
    },
  },
}));

// ── provider mock ───────────────────────────────────────────────────────
// Trivially-succeeding streams for both phase-1 fact extraction and phase-2
// section generation, so a NON-empty module set yields real markdown content.
function makeProvider(): AIProvider {
  return {
    key: "bedrock-gateway",
    model: "mock",
    offline: false,
    chat: vi.fn(async () => ({ content: JSON.stringify({ claims: [] }) })),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
    async *stream(messages, _opts): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1]?.content ?? "");
      if (user.includes("section group now")) {
        yield { type: "delta", content: `## Section\n\nSAS prose.` };
        yield { type: "done" };
        return;
      }
      yield { type: "delta", content: "PURPOSE\nmod." };
      yield { type: "done" };
    },
  } as unknown as AIProvider;
}

vi.mock("../ai/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/index.js")>();
  return {
    ...actual,
    buildProvider: () => makeProvider(),
    loadAIConfig: () => ({ provider: "bedrock-gateway", model: "mock" }),
  };
});

import { synthesizeHolisticDocument } from "./holistic-synthesizer.js";

function seedMetaPrisma(): void {
  mockPrisma.project.findUnique.mockResolvedValue({ name: "SasProj" });
  mockPrisma.codeSymbol.count.mockResolvedValue(3);
  mockPrisma.codeSymbol.groupBy.mockResolvedValue([{ filePath: "sas/etl/load.sas" }]);
  mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
  mockPrisma.codeGraph.findMany.mockResolvedValue([
    { id: "graph-a", repoConnection: { id: "a", projectId: "p1", deletedAt: null } },
  ]);
  mockPrisma.finding.findMany.mockResolvedValue([]);
  mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
  mockPrisma.docsGenFactCache.findUnique.mockResolvedValue(null);
  mockPrisma.docsGenFactCache.upsert.mockResolvedValue({});
}

const sasFn = (id: string, name: string, filePath = "sas/etl/load.sas") => ({
  id,
  codeGraphId: "graph-a",
  qualifiedName: `${filePath}::${name}`,
  kind: "function",
  language: "sas",
  filePath,
  startLine: 1,
  endLine: 40,
});

describe("holistic synthesizer — SAS module filter (loadModules)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BEDROCK_GATEWAY_URL;
    delete process.env.BEDROCK_GATEWAY_BASE_URL;
    process.env.AI_OFFLINE = "0";
    seedMetaPrisma();
  });

  afterEach(() => {
    process.env.AI_OFFLINE = "1";
  });

  it("normal branch: a SAS-only directory with ≥3 function symbols (0 classes) produces a non-empty document", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      sasFn("s1", "macroClean"),
      sasFn("s2", "dataLoad"),
      sasFn("s3", "procSql"),
    ] as never);

    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    // The empty-doc message is NOT rendered → a module qualified.
    expect(result.markdown).not.toContain("No documentable modules");
    expect(result.markdown).toContain("SAS prose.");
  });

  it("normal branch: a SAS directory with only 2 function symbols stays below the ≥3 threshold (empty doc)", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      sasFn("s1", "macroClean"),
      sasFn("s2", "dataLoad"),
    ] as never);

    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    // Below threshold → no module qualifies → empty doc, but symbols existed so
    // the silent-failure guard must surface a degraded warning.
    expect(result.markdown).toContain("No documentable modules");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("mega-module branch: a >200-symbol graph with a SAS file holding ≥3 function symbols qualifies that file", async () => {
    // 250 throw-away symbols in a noise dir (no class, <4 ... actually plenty of
    // functions but all in ONE dir to trip the SPLIT_THRESHOLD of 200), plus a
    // SAS file with exactly 3 SAS function symbols.
    const noise = Array.from({ length: 250 }, (_, i) => ({
      id: `n${i}`,
      codeGraphId: "graph-a",
      qualifiedName: `noise/big.py::fn${i}`,
      kind: "function",
      language: "python",
      filePath: "noise/big.py",
      startLine: i + 1,
      endLine: i + 2,
    }));
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      ...noise,
      sasFn("g1", "macroClean", "sas/etl/transform.sas"),
      sasFn("g2", "dataLoad", "sas/etl/transform.sas"),
      sasFn("g3", "procSql", "sas/etl/transform.sas"),
    ] as never);

    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    expect(result.markdown).not.toContain("No documentable modules");
    expect(result.markdown).toContain("SAS prose.");
  });

  it("mega-module branch: a noise dir with no class and a SAS file with only 2 SAS functions yields an empty doc", async () => {
    const noise = Array.from({ length: 250 }, (_, i) => ({
      id: `n${i}`,
      codeGraphId: "graph-a",
      qualifiedName: `noise/big.py::fn${i}`,
      kind: "function",
      language: "python",
      filePath: "noise/big.py",
      startLine: i + 1,
      endLine: i + 2,
    }));
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      ...noise,
      sasFn("g1", "macroClean", "sas/etl/transform.sas"),
      sasFn("g2", "dataLoad", "sas/etl/transform.sas"),
    ] as never);

    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    expect(result.markdown).toContain("No documentable modules");
    // Symbols existed → degraded, not silent ready.
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("emits a degraded-output warning when modules are empty BUT raw symbols existed", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([sasFn("s1", "onlyOne")] as never);

    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    expect(result.markdown).toContain("No documentable modules");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].severity).toBeDefined();
    expect(result.warnings[0].message.length).toBeGreaterThan(0);
  });

  it("genuinely-zero-symbols case stays a clean empty document with NO warnings", async () => {
    mockPrisma.codeGraph.findMany.mockResolvedValue([]);
    mockPrisma.codeSymbol.findMany.mockResolvedValue([] as never);

    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    expect(result.markdown).toContain("No documentable modules");
    expect(result.warnings).toHaveLength(0);
  });
});
