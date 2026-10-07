/**
 * Tests for the traceability matrix SERVICE aggregation (#737). Drives the real
 * `getAnalysisSnapshot` read-path shape via an injected loader + a mocked prisma
 * for the spine (`requirementCodeMapping`) read, and an injected "Tested by"
 * resolver (#815) — never stubbing the pure builder's internals. Parity with the
 * chain on a real database lives in `tests/traceability-tested-by.sqlite.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import type { AnalysisSnapshot, TraceabilityTestNode } from "@metis/shared";
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
    escalation: null,
    retrieval: null,
    databaseAware: null,
    agents: [
      {
        agentKey: "code",
        source: null,
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        summary: null,
        notes: [],
        errorMessage: null,
        findings: [
          {
            id: "f-1",
            category: "other",
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
        verdict: null,
        acceptanceCriteria: [],
        supportConfidence: null,
      },
    ],
    ...overrides,
  };
}

function mockPrisma(opts: { mappings?: unknown[] } = {}) {
  return {
    requirementCodeMapping: { findMany: vi.fn().mockResolvedValue(opts.mappings ?? []) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function testNode(over: Partial<TraceabilityTestNode>): TraceabilityTestNode {
  return {
    codeSymbolId: "t-1",
    filePath: "server/src/auth.test.ts",
    symbol: "server/src/auth.test.ts::login",
    name: "login",
    startLine: 3,
    convention: "vitest",
    relation: "exercises",
    subject: { filePath: "server/src/auth.ts", symbol: "server/src/auth.ts::login" },
    score: 0.8,
    ...over,
  };
}

/** A resolver double returning `tests` for every requirement id it is asked about. */
function resolver(byRequirement: Record<string, TraceabilityTestNode[]> = {}) {
  return vi.fn(async (_projectId: string, requirementIds: string[]) => {
    const out = new Map<string, TraceabilityTestNode[]>();
    for (const id of requirementIds) if (byRequirement[id]) out.set(id, byRequirement[id]);
    return out;
  });
}

describe("getTraceabilityMatrix", () => {
  it("returns null when the analysis is not visible", async () => {
    const matrix = await getTraceabilityMatrix("missing", {
      prisma: mockPrisma(),
      resolveTests: resolver(),
      loadSnapshot: vi.fn().mockResolvedValue(null),
    });
    expect(matrix).toBeNull();
  });

  it("assembles rows from the snapshot read path with correct links", async () => {
    const prisma = mockPrisma();
    const matrix = await getTraceabilityMatrix("an-1", {
      prisma,
      resolveTests: resolver(),
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
    // The resolver found nothing → no tests.
    expect(row.tests).toEqual([]);
    // Spine + code-graph queries are project-scoped (BOLA defense-in-depth).
    expect(prisma.requirementCodeMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: "proj-1" }) }),
    );
  });

  it("#815 — fills tests from the Tested-by resolver for the analysis's requirements", async () => {
    const resolveTests = resolver({
      "req-1": [
        testNode({}),
        testNode({
          filePath: "server/src/auth_test.go",
          symbol: "server/src/auth_test.go::TestLogin",
          relation: "naming",
        }),
      ],
    });
    const prisma = mockPrisma();
    const matrix = await getTraceabilityMatrix("an-1", {
      prisma,
      resolveTests,
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
    });
    expect(matrix!.rows[0]!.tests).toEqual([
      {
        filePath: "server/src/auth.test.ts",
        symbol: "server/src/auth.test.ts::login",
        relation: "exercises",
      },
      {
        filePath: "server/src/auth_test.go",
        symbol: "server/src/auth_test.go::TestLogin",
        relation: "naming",
      },
    ]);
    expect(matrix!.testsDetection).toBe("heuristic");
    // Scoped to the analysis's project and requirements, on the matrix's own Prisma.
    expect(resolveTests).toHaveBeenCalledTimes(1);
    expect(resolveTests).toHaveBeenCalledWith("proj-1", ["req-1"], undefined, { prisma });
  });

  it("#815 — a requirement the resolver has no tests for renders an empty tests cell", async () => {
    const snap = snapshot();
    snap.requirements.push({ ...snap.requirements[0]!, id: "req-2", evidenceFindingIds: [] });
    const matrix = await getTraceabilityMatrix("an-1", {
      prisma: mockPrisma(),
      resolveTests: resolver({ "req-2": [testNode({})] }),
      loadSnapshot: vi.fn().mockResolvedValue(snap),
    });
    expect(matrix!.rows.map((r) => r.tests.length)).toEqual([0, 1]);
  });

  it("coerces an unknown finding severity to 'info' and a missing coverage to null", async () => {
    const snap = snapshot();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (snap.agents[0]!.findings[0] as any).severity = "bogus";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (snap.requirements[0] as any).coverage = undefined;
    const matrix = await getTraceabilityMatrix("an-1", {
      prisma: mockPrisma(),
      resolveTests: resolver(),
      loadSnapshot: vi.fn().mockResolvedValue(snap),
    });
    expect(matrix!.rows[0]!.findings[0]!.severity).toBe("info");
    expect(matrix!.rows[0]!.coverage).toBeNull();
  });

  it("keeps a spine row whose codeSymbolId is null", async () => {
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
    });
    const matrix = await getTraceabilityMatrix("an-1", {
      prisma,
      resolveTests: resolver(),
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
    });
    const mapped = matrix!.rows[0]!.codeLocations.find((l) => l.source === "deterministic-mapping");
    expect(mapped).toMatchObject({ filePath: "server/src/mapped.ts", startLine: null });
    expect(mapped!.symbolId).toBeUndefined();
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
      resolveTests: resolver(),
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
    });
    const sources = matrix!.rows[0]!.codeLocations.map((l) => l.source).sort();
    expect(sources).toEqual(["citation", "deterministic-mapping"]);
  });
});
