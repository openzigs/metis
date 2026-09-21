/**
 * Holistic synthesizer — repo connector filter unit tests.
 * Epic #671 / Issue #674.
 *
 * Verifies that when a repoConnectorId is provided:
 *   1. prisma.codeGraph.findFirst is called to resolve the codeGraphId
 *   2. prisma.codeSymbol.findMany is called with codeGraphId in the where clause
 *   3. Missing graphs fail closed before providers or project-wide symbol reads
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mock functions so they're available before vi.mock factory runs
// ---------------------------------------------------------------------------
const {
  mockCodeGraphFindFirst,
  mockCodeGraphFindMany,
  mockCodeSymbolFindMany,
  mockCodeSymbolCount,
  mockCodeSymbolGroupBy,
  mockProjectFindUnique,
  mockRepoConnectionFindFirst,
  mockFactCacheFindFirst,
} = vi.hoisted(() => ({
  mockCodeGraphFindFirst: vi.fn(),
  mockCodeGraphFindMany: vi.fn(),
  mockCodeSymbolFindMany: vi.fn(),
  mockCodeSymbolCount: vi.fn(),
  mockCodeSymbolGroupBy: vi.fn(),
  mockProjectFindUnique: vi.fn(),
  mockRepoConnectionFindFirst: vi.fn(),
  mockFactCacheFindFirst: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock prisma
// ---------------------------------------------------------------------------
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: mockCodeGraphFindFirst, findMany: mockCodeGraphFindMany },
    codeSymbol: {
      findMany: mockCodeSymbolFindMany,
      count: mockCodeSymbolCount,
      groupBy: mockCodeSymbolGroupBy,
    },
    project: { findUnique: mockProjectFindUnique },
    repoConnection: { findFirst: mockRepoConnectionFindFirst },
    holisticFactCache: { findFirst: mockFactCacheFindFirst },
  },
}));

// Mock AI provider — not needed for empty-module path
vi.mock("../src/lib/ai/index.js", () => ({
  loadAIConfig: vi.fn(() => ({})),
  buildProvider: vi.fn(() => ({
    chat: vi.fn(async () => ({ content: "{}" })),
  })),
}));

vi.mock("../src/lib/ai/providers/bedrock-direct-provider.js", () => ({
  BedrockDirectProvider: vi.fn(),
}));

import { synthesizeHolisticDocument } from "../../src/lib/docs-gen/holistic-synthesizer.js";
import { buildProvider } from "../src/lib/ai/index.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("synthesizeHolisticDocument — repoConnectorId filter", () => {
  beforeEach(() => {
    mockProjectFindUnique.mockResolvedValue({ name: "Test Project" });
    mockCodeGraphFindMany.mockResolvedValue([
      {
        id: "graph_abc",
        repoConnection: { id: "repo_xyz", projectId: "proj_1", deletedAt: null },
      },
    ]);
    mockCodeSymbolCount.mockResolvedValue(0);
    mockCodeSymbolGroupBy.mockResolvedValue([]);
    mockCodeSymbolFindMany.mockResolvedValue([]);
    mockRepoConnectionFindFirst.mockResolvedValue(null);
    mockFactCacheFindFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("queries codeGraph by repoConnectionId when repoConnectorId is provided", async () => {
    mockCodeGraphFindFirst.mockResolvedValue({ id: "graph_abc" });

    await synthesizeHolisticDocument("proj_1", "business-requirements", "My Doc", {
      repoConnectorId: "repo_xyz",
    });

    expect(mockCodeGraphFindFirst).toHaveBeenCalledWith({
      where: {
        projectId: "proj_1",
        repoConnectionId: "repo_xyz",
        repoConnection: { projectId: "proj_1", deletedAt: null },
      },
      select: { id: true },
    });
  });

  it("passes codeGraphId in the codeSymbol.findMany where clause", async () => {
    mockCodeGraphFindFirst.mockResolvedValue({ id: "graph_abc" });

    await synthesizeHolisticDocument("proj_1", "business-requirements", "My Doc", {
      repoConnectorId: "repo_xyz",
    });

    expect(mockCodeSymbolFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: "proj_1", codeGraphId: "graph_abc" }),
      }),
    );
  });

  it("fails closed instead of falling back to project-wide symbols when the graph is missing", async () => {
    mockCodeGraphFindFirst.mockResolvedValue(null);

    await expect(
      synthesizeHolisticDocument("proj_1", "business-requirements", "My Doc", {
        repoConnectorId: "repo_missing",
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_GRAPH_UNAVAILABLE" });
    expect(mockCodeSymbolFindMany).not.toHaveBeenCalled();
    expect(buildProvider).not.toHaveBeenCalled();
  });

  it("does NOT call codeGraph.findFirst when no repoConnectorId is given", async () => {
    await synthesizeHolisticDocument("proj_1", "business-requirements", "My Doc");

    expect(mockCodeGraphFindFirst).not.toHaveBeenCalled();
  });

  it.each(["", "  "])(
    "rejects an explicit blank repository %j instead of widening",
    async (repoConnectorId) => {
      await expect(
        synthesizeHolisticDocument("proj_1", "architecture", "My Doc", {
          repoConnectorId,
        }),
      ).rejects.toMatchObject({ code: "REPOSITORY_GRAPH_UNAVAILABLE" });
      expect(mockCodeSymbolFindMany).not.toHaveBeenCalled();
      expect(buildProvider).not.toHaveBeenCalled();
    },
  );

  it("passes projectId-only where clause when no repoConnectorId is given", async () => {
    await synthesizeHolisticDocument("proj_1", "business-requirements", "My Doc");

    expect(mockCodeSymbolFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "proj_1" },
      }),
    );
  });
});
