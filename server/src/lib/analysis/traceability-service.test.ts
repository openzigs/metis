/**
 * Tests for the traceability matrix SERVICE aggregation (#737). Drives the real
 * `getAnalysisSnapshot` read-path shape via an injected loader + a mocked prisma
 * for the spine (`requirementCodeMapping`) and code-graph (`codeEdge`) reads —
 * never stubbing the pure builder's internals.
 */
import { describe, it, expect, vi } from "vitest";
import type { AnalysisSnapshot } from "@metis/shared";
import { getTraceabilityMatrix } from "./traceability-service.js";

function snapshot(overrides: Partial<AnalysisSnapshot> = {}): AnalysisSnapshot {
  return {
    id: "an-1",
    projectId: "proj-1",
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    errorMessage: null,
    metadata: null,
    crossDocFindings: null,
    capability: null,
    affectedCode: null,
    agents: [
      {
        agentKey: "code",
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        summary: null,
        notes: [],
        errorMessage: null,
        findings: [
          {
            id: "f-1",
            category: "gap",
            severity: "high",
            title: "Login handler present",
            body: "b",
            tags: [],
            citations: [
              { filePath: "server/src/auth.ts", startLine: 10, endLine: 20, symbolId: "sym-a" },
            ],
            derivation: "inferred",
            confidence: 0.7,
            agentResultId: "ar-1",
            requirementId: null,
          },
        ],
      },
    ],
    requirements: [
      {
        id: "req-1",
        type: "feature",
        title: "Users can log in",
        body: "b",
        priority: "high",
        labels: [],
        storyPoints: null,
        reviewStatus: "draft",
        evidenceFindingIds: ["f-1"],
        coverage: "grounded_in_code",
        version: 1,
      },
    ],
    ...overrides,
  };
}

function mockPrisma(opts: { mappings?: unknown[]; edges?: unknown[] } = {}) {
  return {
    requirementCodeMapping: { findMany: vi.fn().mockResolvedValue(opts.mappings ?? []) },
    codeEdge: { findMany: vi.fn().mockResolvedValue(opts.edges ?? []) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("getTraceabilityMatrix", () => {
  it("returns null when the analysis is not visible", async () => {
    const matrix = await getTraceabilityMatrix("missing", {
      prisma: mockPrisma(),
      loadSnapshot: vi.fn().mockResolvedValue(null),
    });
    expect(matrix).toBeNull();
  });

  it("assembles rows from the snapshot read path with correct links", async () => {
    const prisma = mockPrisma();
    const matrix = await getTraceabilityMatrix("an-1", {
      prisma,
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
    });

    expect(matrix).not.toBeNull();
    expect(matrix!.rows).toHaveLength(1);
    const row = matrix!.rows[0]!;
    expect(row.requirementId).toBe("req-1");
    expect(row.coverage).toBe("grounded_in_code");
    expect(row.findings.map((f) => f.id)).toEqual(["f-1"]);
    expect(row.codeLocations).toEqual([
      {
        filePath: "server/src/auth.ts",
        startLine: 10,
        endLine: 20,
        source: "citation",
        symbolId: "sym-a",
      },
    ]);
    // No edges → no detected tests.
    expect(row.tests).toEqual([]);
    // Spine + code-graph queries are project-scoped (BOLA defense-in-depth).
    expect(prisma.requirementCodeMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: "proj-1" }) }),
    );
  });

  it("detects tests from code-graph edges in test-path files", async () => {
    const prisma = mockPrisma({
      edges: [
        {
          toSymbolId: "sym-a",
          fromSymbol: { filePath: "server/src/auth.test.ts", qualifiedName: "auth.test::login" },
        },
        {
          // non-test file → excluded from the tests column.
          toSymbolId: "sym-a",
          fromSymbol: { filePath: "server/src/caller.ts", qualifiedName: "caller::run" },
        },
      ],
    });
    const matrix = await getTraceabilityMatrix("an-1", {
      prisma,
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
    });
    expect(matrix!.rows[0]!.tests).toEqual([
      { filePath: "server/src/auth.test.ts", symbol: "auth.test::login" },
    ]);
    // Only queried the referenced symbol id.
    expect(prisma.codeEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ toSymbolId: { in: ["sym-a"] }, projectId: "proj-1" }),
      }),
    );
  });

  it("skips the code-graph query when no code citation carries a symbol id", async () => {
    const snap = snapshot();
    snap.agents[0]!.findings[0]!.citations = [
      { filePath: "server/src/auth.ts", startLine: 1, endLine: 2 },
    ];
    const prisma = mockPrisma();
    const matrix = await getTraceabilityMatrix("an-1", {
      prisma,
      loadSnapshot: vi.fn().mockResolvedValue(snap),
    });
    expect(matrix!.rows[0]!.tests).toEqual([]);
    expect(prisma.codeEdge.findMany).not.toHaveBeenCalled();
  });

  it("coerces an unknown finding severity to 'info' and a missing coverage to null", async () => {
    const snap = snapshot();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (snap.agents[0]!.findings[0] as any).severity = "bogus";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (snap.requirements[0] as any).coverage = undefined;
    const matrix = await getTraceabilityMatrix("an-1", {
      prisma: mockPrisma(),
      loadSnapshot: vi.fn().mockResolvedValue(snap),
    });
    expect(matrix!.rows[0]!.findings[0]!.severity).toBe("info");
    expect(matrix!.rows[0]!.coverage).toBeNull();
  });

  it("keeps a spine row whose codeSymbolId is null and de-dupes duplicate test edges", async () => {
    const prisma = mockPrisma({
      mappings: [
        {
          requirementId: "req-1",
          codeSymbolId: null,
          filePath: "server/src/mapped.ts",
          startLine: null,
          endLine: null,
        },
      ],
      edges: [
        // Duplicate edge to the same target from the same test symbol → one link.
        { toSymbolId: "sym-a", fromSymbol: { filePath: "a.test.ts", qualifiedName: "a::t" } },
        { toSymbolId: "sym-a", fromSymbol: { filePath: "a.test.ts", qualifiedName: "a::t" } },
        // Edge with no resolvable fromSymbol → skipped.
        { toSymbolId: "sym-a", fromSymbol: null },
      ],
    });
    const matrix = await getTraceabilityMatrix("an-1", {
      prisma,
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
    });
    const mapped = matrix!.rows[0]!.codeLocations.find((l) => l.source === "deterministic-mapping");
    expect(mapped).toMatchObject({ filePath: "server/src/mapped.ts", startLine: null });
    expect(mapped!.symbolId).toBeUndefined();
    expect(matrix!.rows[0]!.tests).toEqual([{ filePath: "a.test.ts", symbol: "a::t" }]);
  });

  it("folds persisted deterministic-mapping spine rows into code locations", async () => {
    const prisma = mockPrisma({
      mappings: [
        {
          requirementId: "req-1",
          codeSymbolId: "sym-m",
          filePath: "server/src/mapped.ts",
          startLine: 3,
          endLine: 8,
        },
      ],
    });
    const matrix = await getTraceabilityMatrix("an-1", {
      prisma,
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
    });
    const sources = matrix!.rows[0]!.codeLocations.map((l) => l.source).sort();
    expect(sources).toEqual(["citation", "deterministic-mapping"]);
  });
});
