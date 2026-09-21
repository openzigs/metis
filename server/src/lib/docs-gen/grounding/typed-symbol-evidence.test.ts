import { describe, expect, it, vi } from "vitest";
import type { EvidencePolicy } from "../evidence-policy.js";
import { buildGroundingContext, type GroundingContext } from "./grounding-context.js";
import {
  buildTypedSymbolEvidenceRetriever,
  resolveTypedSymbolEvidenceConfig,
  type TypedSymbolEvidenceDeps,
} from "./typed-symbol-evidence.js";

const policy: EvidencePolicy = {
  projectId: "p1",
  generatedDocumentId: "gen1",
  actor: { userId: "alice", role: "developer" },
  repoConnectorId: "repo-a",
  codeGraphId: "graph-a",
  sharedDocumentIds: [],
  allowWebResearch: false,
};

function baseContext(): GroundingContext {
  return buildGroundingContext({
    ragChunks: [
      {
        documentId: "doc-1",
        chunkId: "chunk-1",
        filename: "connector:repo:repo-a:src/orders/OrderService.ts",
        text: "existing baseline evidence",
        evidenceClass: "repository-source",
        repository: { repoConnectorId: "repo-a", codeGraphId: "graph-a" },
      },
    ],
  });
}

function deps(overrides: Partial<TypedSymbolEvidenceDeps> = {}): TypedSymbolEvidenceDeps {
  return {
    searcher: {
      search: vi.fn(async () => [
        {
          symbolId: "sym-a",
          filePath: "src/orders/OrderService.ts",
          name: "OrderService.create",
          kind: "method",
          score: 0.91,
          snippet: "create(input) { return this.queueFulfillment(); }",
        },
        {
          symbolId: "sym-b",
          filePath: "src/orders/OrderService.ts",
          name: "OrderService.queueFulfillment",
          kind: "method",
          score: 0.82,
          snippet: "queueFulfillment(orderId) { return `queued:${orderId}`; }",
        },
      ]),
    },
    hydrateSymbols: vi.fn(async () => [
      {
        symbolId: "sym-a",
        qualifiedName: "orders.OrderService.create",
        filePath: "src/orders/OrderService.ts",
        startLine: 20,
        endLine: 23,
        codeGraphId: "graph-a",
      },
    ]),
    hydrateNeighborSymbols: vi.fn(async () => [
      {
        symbolId: "sym-b",
        qualifiedName: "orders.OrderService.queueFulfillment",
        filePath: "src/orders/OrderService.ts",
        startLine: 16,
        endLine: 18,
        codeGraphId: "graph-a",
      },
    ]),
    loadRepositories: vi.fn(
      async () =>
        new Map([
          [
            "graph-a",
            {
              codeGraphId: "graph-a",
              repoConnectorId: "repo-a",
              root: "/trusted/repo-a",
              commitSha: "1111111",
            },
          ],
          [
            "graph-b",
            {
              codeGraphId: "graph-b",
              repoConnectorId: "repo-b",
              root: "/trusted/repo-b",
              commitSha: "2222222",
            },
          ],
        ]),
    ),
    readSourceSpan: vi.fn(async ({ symbol }) => ({
      text: [
        `${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`,
        "  create(input) {",
        "    return this.queueFulfillment();",
        "  }",
      ].join("\n"),
      linesRead: symbol.endLine - symbol.startLine + 1,
    })),
    ...overrides,
  };
}

describe("resolveTypedSymbolEvidenceConfig", () => {
  it("stays off by default with bounded budgets", () => {
    expect(resolveTypedSymbolEvidenceConfig()).toEqual({
      enabled: false,
      maxSymbols: 6,
      neighborDepth: 1,
      maxNeighbors: 6,
      maxSourceLines: 80,
      contextBefore: 2,
      contextAfter: 2,
    });
  });

  it("rejects invalid budgets instead of silently widening scope", () => {
    expect(() => resolveTypedSymbolEvidenceConfig({ maxSymbols: 0 })).toThrow(/maxSymbols/i);
    expect(() => resolveTypedSymbolEvidenceConfig({ neighborDepth: -1 })).toThrow(/neighborDepth/i);
    expect(() => resolveTypedSymbolEvidenceConfig({ maxSourceLines: 0 })).toThrow(
      /maxSourceLines/i,
    );
  });
});

describe("buildTypedSymbolEvidenceRetriever", () => {
  it("preserves the baseline context when disabled", async () => {
    const baseRetriever = vi.fn(async () => baseContext());
    const adapter = buildTypedSymbolEvidenceRetriever(
      { projectId: "p1", policy, baseRetriever },
      deps(),
    );

    const result = await adapter.groundingForSection({ id: "overview", query: "order flow" });
    expect(result).toEqual(baseContext());
    expect(adapter.report).toMatchObject({ enabled: false, sectionsAttempted: 0 });
  });

  it("augments baseline grounding with trusted repo-scoped live source spans", async () => {
    const baseRetriever = vi.fn(async () => baseContext());
    const adapterDeps = deps();
    const adapter = buildTypedSymbolEvidenceRetriever(
      {
        projectId: "p1",
        policy,
        baseRetriever,
        config: { enabled: true, maxSymbols: 2, maxNeighbors: 1, maxSourceLines: 20 },
      },
      adapterDeps,
    );

    const result = await adapter.groundingForSection({ id: "overview", query: "order flow" });
    expect(result?.sources.map((source) => source.sourceId)).toEqual([
      "facts:symbol:repo%3A%255B%2522repo-a%2522%252C%2522graph-a%2522%252C%2522src%252Forders%252FOrderService.ts%2522%255D:sym-a:20-23",
      "facts:symbol:repo%3A%255B%2522repo-a%2522%252C%2522graph-a%2522%252C%2522src%252Forders%252FOrderService.ts%2522%255D:sym-b:16-18",
      "rag:doc-1:chunk-1",
    ]);
    expect(result?.sources[0]).toMatchObject({
      kind: "facts",
      evidenceClass: "repository-source",
      repository: { repoConnectorId: "repo-a", codeGraphId: "graph-a" },
    });
    expect(adapter.report).toMatchObject({
      enabled: true,
      sectionsAttempted: 1,
      sectionsAugmented: 1,
      symbolsHydrated: 2,
      neighborSymbolsHydrated: 1,
      budgetExhausted: false,
    });
    expect(adapterDeps.hydrateSymbols).toHaveBeenCalledWith(["sym-a", "sym-b"], {
      projectId: "p1",
      codeGraphId: "graph-a",
    });
  });

  it("disambiguates identical file paths across repositories and keeps the trusted repo only", async () => {
    const baseRetriever = vi.fn(async () => buildGroundingContext({}));
    const adapter = buildTypedSymbolEvidenceRetriever(
      {
        projectId: "p1",
        policy,
        baseRetriever,
        config: { enabled: true, maxSymbols: 2 },
      },
      deps({
        hydrateSymbols: vi.fn(async () => [
          {
            symbolId: "sym-a",
            qualifiedName: "orders.OrderService.create",
            filePath: "src/shared/File.ts",
            startLine: 10,
            endLine: 12,
            codeGraphId: "graph-a",
          },
          {
            symbolId: "sym-foreign",
            qualifiedName: "foreign.OrderService.create",
            filePath: "src/shared/File.ts",
            startLine: 10,
            endLine: 12,
            codeGraphId: "graph-b",
          },
        ]),
        hydrateNeighborSymbols: vi.fn(async () => []),
      }),
    );

    const result = await adapter.groundingForSection({ id: "overview", query: "shared file" });
    expect(result?.sources).toHaveLength(1);
    expect(result?.sources[0]?.repository).toEqual({
      repoConnectorId: "repo-a",
      codeGraphId: "graph-a",
    });
  });

  it("enforces source-reading and neighbor budgets instead of widening context", async () => {
    const baseRetriever = vi.fn(async () => buildGroundingContext({}));
    const adapter = buildTypedSymbolEvidenceRetriever(
      {
        projectId: "p1",
        policy,
        baseRetriever,
        config: { enabled: true, maxSymbols: 2, maxNeighbors: 1, maxSourceLines: 3 },
      },
      deps(),
    );

    const result = await adapter.groundingForSection({ id: "overview", query: "order flow" });
    expect(result?.sources).toHaveLength(1);
    expect(adapter.report).toMatchObject({ budgetExhausted: true, symbolsHydrated: 1 });
  });

  it("fails safely back to the baseline context when live source hydration is unavailable", async () => {
    const baseRetriever = vi.fn(async () => baseContext());
    const adapter = buildTypedSymbolEvidenceRetriever(
      {
        projectId: "p1",
        policy,
        baseRetriever,
        config: { enabled: true },
      },
      deps({
        readSourceSpan: vi.fn(async () => {
          throw new Error("Repository source path unavailable");
        }),
      }),
    );

    const result = await adapter.groundingForSection({ id: "overview", query: "order flow" });
    expect(result).toEqual(baseContext());
    expect(adapter.report).toMatchObject({
      enabled: true,
      sectionsAttempted: 1,
      sectionsAugmented: 0,
      fallbackReason: "Repository source path unavailable",
    });
  });

  it("returns the baseline when no trusted symbol spans can be hydrated", async () => {
    const baseRetriever = vi.fn(async () => undefined);
    const adapter = buildTypedSymbolEvidenceRetriever(
      {
        projectId: "p1",
        policy,
        baseRetriever,
        config: { enabled: true, neighborDepth: 0, maxNeighbors: 0 },
      },
      deps({
        hydrateSymbols: vi.fn(async () => []),
        hydrateNeighborSymbols: vi.fn(async () => {
          throw new Error("should not run");
        }),
      }),
    );

    const result = await adapter.groundingForSection({ id: "overview", query: "unknown" });
    expect(result).toBeUndefined();
    expect(adapter.report).toMatchObject({
      sectionsAttempted: 1,
      sectionsAugmented: 0,
      symbolsHydrated: 0,
      neighborSymbolsHydrated: 0,
      budgetExhausted: false,
    });
  });

  it("dedupes repeated symbol IDs across direct and neighbor hydration", async () => {
    const baseRetriever = vi.fn(async () => buildGroundingContext({}));
    const adapter = buildTypedSymbolEvidenceRetriever(
      {
        projectId: "p1",
        policy,
        baseRetriever,
        config: { enabled: true },
      },
      deps({
        hydrateSymbols: vi.fn(async () => [
          {
            symbolId: "sym-a",
            qualifiedName: "orders.OrderService.create",
            filePath: "src/orders/OrderService.ts",
            startLine: 20,
            endLine: 23,
            codeGraphId: "graph-a",
          },
        ]),
        hydrateNeighborSymbols: vi.fn(async () => [
          {
            symbolId: "sym-a",
            qualifiedName: "orders.OrderService.create",
            filePath: "src/orders/OrderService.ts",
            startLine: 20,
            endLine: 23,
            codeGraphId: "graph-a",
          },
        ]),
      }),
    );

    const result = await adapter.groundingForSection({ id: "overview", query: "order flow" });
    expect(result?.sources).toHaveLength(1);
    expect(adapter.report).toMatchObject({
      symbolsHydrated: 1,
      neighborSymbolsHydrated: 0,
    });
  });

  it("records a string fallback reason when a dependency throws a non-Error value", async () => {
    const baseRetriever = vi.fn(async () => baseContext());
    const adapter = buildTypedSymbolEvidenceRetriever(
      {
        projectId: "p1",
        policy,
        baseRetriever,
        config: { enabled: true },
      },
      deps({
        searcher: {
          search: vi.fn(async () => {
            throw "search offline";
          }),
        },
      }),
    );

    const result = await adapter.groundingForSection({ id: "overview", query: "order flow" });
    expect(result).toEqual(baseContext());
    expect(adapter.report).toMatchObject({
      fallbackReason: "search offline",
      sectionsAttempted: 1,
      sectionsAugmented: 0,
    });
  });
});

describe("buildTypedSymbolEvidenceRetriever default dependency path", () => {
  it("hydrates direct and neighbor symbols with the built-in SQL and source readers", async () => {
    const search = vi.fn(async () => [{ symbolId: "sym-a" }]);
    const findManySymbols = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "sym-a",
          qualifiedName: "orders.OrderService.create",
          filePath: "src/orders/OrderService.ts",
          startLine: 3,
          endLine: 4,
          codeGraphId: "graph-a",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "sym-b",
          qualifiedName: "orders.OrderService.queueFulfillment",
          filePath: "src/orders/OrderService.ts",
          startLine: 1,
          endLine: 2,
          codeGraphId: "graph-a",
        },
      ]);
    const findManyEdges = vi.fn(async () => [{ fromSymbolId: "sym-a", toSymbolId: "sym-b" }]);
    const loadRepositories = vi.fn(
      async () =>
        new Map([
          [
            "graph-a",
            {
              codeGraphId: "graph-a",
              repoConnectorId: "repo-a",
              root: "/trusted/repo-a",
              commitSha: "abc",
            },
          ],
        ]),
    );
    const resolveSourcePath = vi.fn(async (_root: string, _filePath: string) => {
      const os = await import("node:os");
      const path = await import("node:path");
      const fs = await import("node:fs/promises");
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "typed-symbol-evidence-"));
      const file = path.join(root, "OrderService.ts");
      await fs.writeFile(
        file,
        [
          "export function queueFulfillment() {",
          '  return "queued";',
          "}",
          "export function create() {",
          "  return queueFulfillment();",
          "}",
        ].join("\n"),
        "utf8",
      );
      return file;
    });

    vi.resetModules();
    vi.doMock("../../code-graph/project-code-searcher.js", () => ({
      createDefaultCodeSearcher: vi.fn(() => ({ search })),
    }));
    vi.doMock("../../prisma.js", () => ({
      prisma: {
        codeSymbol: { findMany: findManySymbols },
        codeEdge: { findMany: findManyEdges },
      },
    }));
    vi.doMock("../repository-sources.js", async () => {
      const actual = await vi.importActual<typeof import("../repository-sources.js")>(
        "../repository-sources.js",
      );
      return {
        ...actual,
        loadRepositorySources: loadRepositories,
        resolveSourcePath,
      };
    });

    const { buildTypedSymbolEvidenceRetriever: buildDefaultRetriever } =
      await import("./typed-symbol-evidence.js");
    const adapter = buildDefaultRetriever({
      projectId: "p1",
      policy,
      baseRetriever: async () => undefined,
      config: { enabled: true, maxNeighbors: 1, neighborDepth: 1, maxSourceLines: 10 },
    });

    const result = await adapter.groundingForSection({ id: "overview", query: "order flow" });
    expect(search).toHaveBeenCalledWith("order flow", "p1", { limit: 6 });
    expect(findManySymbols).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "p1",
          id: { in: ["sym-a"] },
          codeGraphId: "graph-a",
        }),
      }),
    );
    expect(findManyEdges).toHaveBeenCalledTimes(1);
    expect(findManySymbols).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["sym-b"] },
        }),
      }),
    );
    expect(loadRepositories).toHaveBeenCalledWith({ projectId: "p1", codeGraphId: "graph-a" });
    expect(result?.sources).toHaveLength(2);
    expect(result?.sources[0]?.text).toContain("src/orders/OrderService.ts:1-6");
    expect(adapter.report).toMatchObject({
      sectionsAugmented: 1,
      symbolsHydrated: 2,
      neighborSymbolsHydrated: 1,
    });
  });

  it("stops neighbor traversal at the configured budget and skips untrusted repositories", async () => {
    const search = vi.fn(async () => [{ symbolId: "sym-a" }]);
    const symbols = [
      {
        id: "sym-a",
        qualifiedName: "orders.OrderService.create",
        filePath: "src/orders/OrderService.ts",
        startLine: 3,
        endLine: 4,
        codeGraphId: "graph-a",
      },
      {
        id: "sym-b",
        qualifiedName: "foreign.OrderService.create",
        filePath: "src/orders/Other.ts",
        startLine: 1,
        endLine: 1,
        codeGraphId: "graph-b",
      },
      {
        id: "sym-c",
        qualifiedName: "orders.OverBudget",
        filePath: "src/orders/Extra.ts",
        startLine: 1,
        endLine: 1,
        codeGraphId: "graph-a",
      },
    ];
    const findManySymbols = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      symbols.filter((symbol) => where.id.in.includes(symbol.id)),
    );
    const findManyEdges = vi.fn(async () => [
      { fromSymbolId: "sym-a", toSymbolId: "sym-b" },
      { fromSymbolId: "sym-a", toSymbolId: "sym-c" },
    ]);
    const loadRepositories = vi.fn(
      async () =>
        new Map([
          [
            "graph-a",
            {
              codeGraphId: "graph-a",
              repoConnectorId: "repo-a",
              root: "/trusted/repo-a",
              commitSha: "abc",
            },
          ],
          [
            "graph-b",
            {
              codeGraphId: "graph-b",
              repoConnectorId: undefined,
              root: "/trusted/repo-b",
              commitSha: "def",
            },
          ],
        ]),
    );

    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "typed-neighbor-budget-"));
    const file = path.join(root, "OrderService.ts");
    await fs.writeFile(file, "// trusted\n// source\nexport function create() {\n  return 1;\n}\n");
    const resolveSourcePath = vi.fn(async (repoRoot: string, filePath: string) => {
      expect(repoRoot).toBe("/trusted/repo-a");
      expect(filePath).toBe("src/orders/OrderService.ts");
      return file;
    });

    vi.resetModules();
    vi.doMock("../../code-graph/project-code-searcher.js", () => ({
      createDefaultCodeSearcher: vi.fn(() => ({ search })),
    }));
    vi.doMock("../../prisma.js", () => ({
      prisma: {
        codeSymbol: { findMany: findManySymbols },
        codeEdge: { findMany: findManyEdges },
      },
    }));
    vi.doMock("../repository-sources.js", async () => {
      const actual = await vi.importActual<typeof import("../repository-sources.js")>(
        "../repository-sources.js",
      );
      return {
        ...actual,
        loadRepositorySources: loadRepositories,
        resolveSourcePath,
      };
    });

    const { buildTypedSymbolEvidenceRetriever: buildDefaultRetriever } =
      await import("./typed-symbol-evidence.js");
    const adapter = buildDefaultRetriever({
      projectId: "p1",
      // Project-wide policy lets the repository trust guard, not graph filtering,
      // reject sym-b. The trusted direct source must still load successfully.
      policy: { ...policy, codeGraphId: undefined, repoConnectorId: undefined },
      baseRetriever: async () => buildGroundingContext({}),
      config: { enabled: true, maxNeighbors: 1, neighborDepth: 2 },
    });

    try {
      const result = await adapter.groundingForSection({ id: "overview", query: "order flow" });
      expect(findManyEdges).toHaveBeenCalledTimes(1);
      expect(findManySymbols.mock.calls.map(([query]) => query.where.id.in)).toEqual([
        ["sym-a"],
        ["sym-b"],
      ]);
      expect(resolveSourcePath.mock.calls).toEqual([
        ["/trusted/repo-a", "src/orders/OrderService.ts"],
      ]);
      expect(result?.sources).toHaveLength(1);
      expect(result?.sources[0]?.text).toContain("export function create()");
      expect(adapter.report).toMatchObject({
        sectionsAttempted: 1,
        sectionsAugmented: 1,
        symbolsHydrated: 1,
        neighborSymbolsHydrated: 0,
      });
      expect(adapter.report.fallbackReason).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("proves maxNeighbors changes the hydrated evidence set independently", async () => {
    const baseRetriever = vi.fn(async () => buildGroundingContext({}));
    const adapterDeps = deps({
      hydrateSymbols: vi.fn(async () => [
        {
          symbolId: "sym-a",
          qualifiedName: "orders.OrderService.create",
          filePath: "src/orders/OrderService.ts",
          startLine: 20,
          endLine: 23,
          codeGraphId: "graph-a",
        },
      ]),
      hydrateNeighborSymbols: vi.fn(async (_ids, scope) =>
        scope.maxNeighbors === 0
          ? []
          : [
              {
                symbolId: "sym-b",
                qualifiedName: "orders.OrderService.queueFulfillment",
                filePath: "src/orders/OrderService.ts",
                startLine: 16,
                endLine: 18,
                codeGraphId: "graph-a",
              },
            ],
      ),
    });

    const withNeighbors = buildTypedSymbolEvidenceRetriever(
      {
        projectId: "p1",
        policy,
        baseRetriever,
        config: { enabled: true, maxNeighbors: 1 },
      },
      adapterDeps,
    );
    const withoutNeighbors = buildTypedSymbolEvidenceRetriever(
      {
        projectId: "p1",
        policy,
        baseRetriever,
        config: { enabled: true, maxNeighbors: 0 },
      },
      adapterDeps,
    );

    const withResult = await withNeighbors.groundingForSection({
      id: "overview",
      query: "order flow",
    });
    const withoutResult = await withoutNeighbors.groundingForSection({
      id: "overview",
      query: "order flow",
    });

    expect(withResult?.sources).toHaveLength(2);
    expect(withoutResult?.sources).toHaveLength(1);
  });
});
