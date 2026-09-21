/**
 * Tests for Epic #486 / Issue #489 — Discovery Agent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    codeSymbol: { findMany: vi.fn() },
    codeEdge: { findMany: vi.fn() },
    finding: { findMany: vi.fn() },
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi
    .fn()
    .mockResolvedValue("function hello(name: string): string {\n  return name;\n}\n"),
}));

import { prisma } from "../../src/lib/prisma.js";
import {
  runDiscoveryAgent,
  synthesizeBusinessRequirements,
  isSasBusinessSymbol,
} from "../../src/lib/docs-gen/discovery-agent.js";

const mockPrisma = vi.mocked(prisma);

describe("runDiscoveryAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no symbols exist", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([]);
    const result = await runDiscoveryAgent("proj-1");
    expect(result).toEqual([]);
  });

  it("scopes symbol discovery to a specific code graph when requested", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([]);

    await runDiscoveryAgent("proj-1", { codeGraphId: "graph-1" });

    expect(mockPrisma.codeSymbol.findMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1", codeGraphId: "graph-1" },
      orderBy: [{ filePath: "asc" }, { startLine: "asc" }],
    });
  });

  it("scopes edge discovery to the same code graph when symbols are present", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      {
        id: "s1",
        qualifiedName: "ScopedClass",
        kind: "class",
        filePath: "/a/scoped.ts",
        startLine: 1,
        endLine: 20,
        projectId: "proj-1",
        contentHash: "h1",
      },
    ] as never);
    mockPrisma.codeEdge.findMany.mockResolvedValue([]);
    mockPrisma.finding.findMany.mockResolvedValue([]);

    await runDiscoveryAgent("proj-1", { codeGraphId: "graph-1" });

    expect(mockPrisma.codeEdge.findMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1", codeGraphId: "graph-1" },
    });
  });

  it("filters non-documentable symbols (modules, short functions)", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      {
        id: "s1",
        qualifiedName: "index",
        kind: "module",
        filePath: "/a/index.ts",
        startLine: 1,
        endLine: 2,
        projectId: "proj-1",
        contentHash: "h1",
      },
      {
        id: "s2",
        qualifiedName: "tiny",
        kind: "function",
        filePath: "/a/utils.ts",
        startLine: 1,
        endLine: 3,
        projectId: "proj-1",
        contentHash: "h2",
      },
    ] as never);
    mockPrisma.codeEdge.findMany.mockResolvedValue([]);
    mockPrisma.finding.findMany.mockResolvedValue([]);

    const result = await runDiscoveryAgent("proj-1");
    expect(result).toHaveLength(0);
  });

  it("includes classes and significant functions", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      {
        id: "s1",
        qualifiedName: "MyService",
        kind: "class",
        filePath: "/a/service.ts",
        startLine: 1,
        endLine: 50,
        projectId: "proj-1",
        contentHash: "h1",
      },
      {
        id: "s2",
        qualifiedName: "processData",
        kind: "function",
        filePath: "/a/process.ts",
        startLine: 1,
        endLine: 30,
        projectId: "proj-1",
        contentHash: "h2",
      },
      {
        id: "s3",
        qualifiedName: "helper",
        kind: "function",
        filePath: "/a/utils.ts",
        startLine: 1,
        endLine: 3,
        projectId: "proj-1",
        contentHash: "h3",
      },
    ] as never);
    mockPrisma.codeEdge.findMany.mockResolvedValue([]);
    mockPrisma.finding.findMany.mockResolvedValue([]);

    const result = await runDiscoveryAgent("proj-1");
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.map((s) => s.symbolName)).toContain("MyService");
    expect(result.map((s) => s.symbolName)).toContain("processData");
  });

  it("populates call graph relationships", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      {
        id: "s1",
        qualifiedName: "Caller",
        kind: "class",
        filePath: "/a/a.ts",
        startLine: 1,
        endLine: 20,
        projectId: "proj-1",
        contentHash: "h1",
      },
      {
        id: "s2",
        qualifiedName: "Callee",
        kind: "class",
        filePath: "/a/b.ts",
        startLine: 1,
        endLine: 20,
        projectId: "proj-1",
        contentHash: "h2",
      },
    ] as never);
    mockPrisma.codeEdge.findMany.mockResolvedValue([
      {
        id: "e1",
        fromSymbolId: "s1",
        toSymbolId: "s2",
        toQualifiedName: "Callee",
        kind: "calls",
        projectId: "proj-1",
        filePath: "/a/a.ts",
        line: 5,
      },
    ] as never);
    mockPrisma.finding.findMany.mockResolvedValue([]);

    const result = await runDiscoveryAgent("proj-1");
    const caller = result.find((s) => s.symbolName === "Caller");
    expect(caller?.callsTo).toContain("Callee");
  });

  it("assigns correct complexity level based on line count", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      {
        id: "s1",
        qualifiedName: "SmallClass",
        kind: "class",
        filePath: "/a/s.ts",
        startLine: 1,
        endLine: 15,
        projectId: "proj-1",
        contentHash: "h1",
      },
      {
        id: "s2",
        qualifiedName: "BigClass",
        kind: "class",
        filePath: "/a/b.ts",
        startLine: 1,
        endLine: 100,
        projectId: "proj-1",
        contentHash: "h2",
      },
    ] as never);
    mockPrisma.codeEdge.findMany.mockResolvedValue([]);
    mockPrisma.finding.findMany.mockResolvedValue([]);

    const result = await runDiscoveryAgent("proj-1");
    const small = result.find((s) => s.symbolName === "SmallClass");
    const big = result.find((s) => s.symbolName === "BigClass");
    expect(small?.complexity).toBe("low");
    expect(big?.complexity).toBe("high");
  });
});

describe("isSasBusinessSymbol", () => {
  it("matches only SAS-origin function symbols", () => {
    expect(isSasBusinessSymbol({ kind: "function", language: "sas" })).toBe(true);
    expect(isSasBusinessSymbol({ kind: "type", language: "sas" })).toBe(false);
    expect(isSasBusinessSymbol({ kind: "module", language: "sas" })).toBe(false);
    expect(isSasBusinessSymbol({ kind: "function", language: "ts" })).toBe(false);
    expect(isSasBusinessSymbol({ kind: "function", language: null })).toBe(false);
  });
});

describe("synthesizeBusinessRequirements — SAS-aware documentable filter (#200)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.finding.findMany.mockResolvedValue([] as never);
  });

  const sasFn = (id: string, name: string) => ({
    id,
    qualifiedName: `sas/etl/load.sas::${name}`,
    kind: "function",
    language: "sas",
    filePath: "sas/etl/load.sas",
    startLine: 1,
    endLine: 40,
    projectId: "proj-1",
    contentHash: id,
  });

  it("treats a SAS-only directory with ≥3 function symbols as documentable", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      sasFn("s1", "%macro clean"),
      sasFn("s2", "load"),
      sasFn("s3", "proc sql"),
    ] as never);

    const result = await synthesizeBusinessRequirements("proj-1");
    // ≥1 module qualifies → the holistic synthesizer's empty-doc message is
    // NOT triggered.
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("leaves the non-SAS rule unchanged (3 plain functions, no class → not documentable)", async () => {
    const plainFn = (id: string, name: string) => ({
      id,
      qualifiedName: `src/util.ts::${name}`,
      kind: "function",
      language: "ts",
      filePath: "src/util.ts",
      startLine: 1,
      endLine: 40,
      projectId: "proj-1",
      contentHash: id,
    });
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      plainFn("t1", "a"),
      plainFn("t2", "b"),
      plainFn("t3", "c"),
    ] as never);

    const result = await synthesizeBusinessRequirements("proj-1");
    expect(result).toHaveLength(0);
  });

  it("qualifies a mixed directory via the SAS-relaxed rule without weakening non-SAS", async () => {
    // A directory with only SAS functions (no class) qualifies; the same
    // directory's non-SAS symbols never lower the bar for other dirs.
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      sasFn("s1", "macroA"),
      sasFn("s2", "macroB"),
      sasFn("s3", "macroC"),
      // A non-SAS function in a DIFFERENT dir with no class → must NOT qualify.
      {
        id: "x1",
        qualifiedName: "src/other.ts::lonely",
        kind: "function",
        language: "ts",
        filePath: "src/other.ts",
        startLine: 1,
        endLine: 40,
        projectId: "proj-1",
        contentHash: "x1",
      },
    ] as never);

    const result = await synthesizeBusinessRequirements("proj-1");
    expect(result.length).toBeGreaterThanOrEqual(1);
    // Only the SAS directory should be documented.
    expect(result.every((s) => s.modulePath.includes("sas/etl"))).toBe(true);
  });
});
