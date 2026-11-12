/**
 * #2377 — the pre-flight "is there source code?" answer counts code the way the
 * synthesizer does: within the chosen scope, and without OS/archive junk.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    codeSymbol: { findMany: vi.fn() },
    codeGraph: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock("../prisma.js", () => ({ prisma: mockPrisma }));

import {
  SOURCE_CODE_PAGE,
  hasIndexedSourceCode,
  scopeHasIndexedSourceCode,
} from "./indexed-source-code.js";

type Where = { projectId: string; codeGraphId?: string; filePath?: { gt: string } };

/**
 * A symbol table: `findMany` answers as the database would, filtering on the
 * scope and the `filePath > after` cursor, ordered by path, `take` rows.
 */
function serveSymbols(rows: Array<{ projectId: string; codeGraphId: string; filePath: string }>) {
  mockPrisma.codeSymbol.findMany.mockImplementation(
    async ({ where, take }: { where: Where; take: number }) =>
      rows
        .filter((r) => r.projectId === where.projectId)
        .filter((r) => where.codeGraphId === undefined || r.codeGraphId === where.codeGraphId)
        .filter((r) => where.filePath === undefined || r.filePath > where.filePath.gt)
        .sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0))
        .slice(0, take)
        .map(({ filePath }) => ({ filePath })),
  );
}

const sym = (filePath: string, codeGraphId = "g1", projectId = "p1") => ({
  projectId,
  codeGraphId,
  filePath,
});

describe("hasIndexedSourceCode (#2377)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is false for a project with no symbols at all", async () => {
    serveSymbols([]);
    await expect(hasIndexedSourceCode({ projectId: "p1", codeGraphId: "g1" })).resolves.toBe(false);
  });

  it("is true once a real source file is indexed", async () => {
    serveSymbols([sym("src/app.ts")]);
    await expect(hasIndexedSourceCode({ projectId: "p1", codeGraphId: "g1" })).resolves.toBe(true);
  });

  it("is false when every symbol is OS/archive junk, as the synthesizer counts it", async () => {
    serveSymbols([
      sym("__MACOSX/RISK/src/._calc.sas"),
      sym("src/._other.sas"),
      sym("src/.DS_Store"),
      sym("assets/Thumbs.db"),
    ]);
    await expect(hasIndexedSourceCode({ projectId: "p1", codeGraphId: "g1" })).resolves.toBe(false);
  });

  it("never counts another project's symbols", async () => {
    serveSymbols([sym("src/app.ts", "g9", "other-project")]);
    await expect(hasIndexedSourceCode({ projectId: "p1", codeGraphId: "g1" })).resolves.toBe(false);
    expect(mockPrisma.codeSymbol.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p1", codeGraphId: "g1" } }),
    );
  });

  it("pages past a full page of junk to the first real file", async () => {
    const junk = Array.from({ length: SOURCE_CODE_PAGE + 5 }, (_, i) =>
      sym(`__MACOSX/src/._f${String(i).padStart(4, "0")}.sas`),
    );
    serveSymbols([...junk, sym("zz/real.sas")]);
    await expect(hasIndexedSourceCode({ projectId: "p1", codeGraphId: "g1" })).resolves.toBe(true);
    expect(mockPrisma.codeSymbol.findMany).toHaveBeenCalledTimes(2);
    // The second page starts after the last path the first page judged.
    expect(mockPrisma.codeSymbol.findMany.mock.calls[1]![0].where).toEqual({
      projectId: "p1",
      codeGraphId: "g1",
      filePath: { gt: junk[SOURCE_CODE_PAGE - 1]!.filePath },
    });
  });

  it("stops after a short page of junk without another query", async () => {
    serveSymbols([sym("__MACOSX/a/._x.sas")]);
    await expect(hasIndexedSourceCode({ projectId: "p1", codeGraphId: "g1" })).resolves.toBe(false);
    expect(mockPrisma.codeSymbol.findMany).toHaveBeenCalledTimes(1);
  });

  it("ends when an exactly full page of junk is followed by nothing", async () => {
    serveSymbols(
      Array.from({ length: SOURCE_CODE_PAGE }, (_, i) =>
        sym(`__MACOSX/src/._f${String(i).padStart(4, "0")}.sas`),
      ),
    );
    await expect(hasIndexedSourceCode({ projectId: "p1", codeGraphId: "g1" })).resolves.toBe(false);
    expect(mockPrisma.codeSymbol.findMany).toHaveBeenCalledTimes(2);
  });
});

describe("scopeHasIndexedSourceCode (#2377)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the whole project when no repository is chosen", async () => {
    mockPrisma.codeGraph.findMany.mockResolvedValue([{ id: "g1" }, { id: "g2" }]);
    serveSymbols([sym("src/app.ts", "g2")]);
    await expect(scopeHasIndexedSourceCode("p1")).resolves.toBe(true);
    expect(mockPrisma.codeGraph.findFirst).not.toHaveBeenCalled();
  });

  it("scopes every whole-project symbol query to one graph, so it fits the (codeGraphId, filePath) index", async () => {
    mockPrisma.codeGraph.findMany.mockResolvedValue([{ id: "g1" }, { id: "g2" }]);
    serveSymbols([sym("__MACOSX/._a.ts", "g1"), sym("src/app.ts", "g2")]);
    await expect(scopeHasIndexedSourceCode("p1")).resolves.toBe(true);
    expect(mockPrisma.codeGraph.findMany).toHaveBeenCalledWith({
      where: { projectId: "p1" },
      select: { id: true },
    });
    const wheres = mockPrisma.codeSymbol.findMany.mock.calls.map((c) => c[0].where);
    expect(wheres).toEqual([
      { projectId: "p1", codeGraphId: "g1" },
      { projectId: "p1", codeGraphId: "g2" },
    ]);
  });

  it("is false for a project with no code graphs, without a symbol query", async () => {
    mockPrisma.codeGraph.findMany.mockResolvedValue([]);
    await expect(scopeHasIndexedSourceCode("p1")).resolves.toBe(false);
    expect(mockPrisma.codeSymbol.findMany).not.toHaveBeenCalled();
  });

  it("is false when every graph holds only junk", async () => {
    mockPrisma.codeGraph.findMany.mockResolvedValue([{ id: "g1" }, { id: "g2" }]);
    serveSymbols([sym(".DS_Store", "g1"), sym("x/Thumbs.db", "g2")]);
    await expect(scopeHasIndexedSourceCode("p1")).resolves.toBe(false);
  });

  it("is false for an empty repository even while another repository is indexed", async () => {
    // g1 is the chosen repository's graph: empty. g2 belongs to another repository.
    mockPrisma.codeGraph.findFirst.mockResolvedValue({ id: "g1" });
    serveSymbols([sym("src/app.ts", "g2")]);
    await expect(scopeHasIndexedSourceCode("p1", "repo-1")).resolves.toBe(false);
    expect(mockPrisma.codeSymbol.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p1", codeGraphId: "g1" } }),
    );
    // The graph is resolved within the project, as generation resolves it.
    expect(mockPrisma.codeGraph.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: "p1", repoConnectionId: "repo-1" }),
      }),
    );
  });

  it("is true for a repository whose own graph holds source code", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue({ id: "g1" });
    serveSymbols([sym("src/app.ts", "g1")]);
    await expect(scopeHasIndexedSourceCode("p1", "repo-1")).resolves.toBe(true);
  });

  it("is false for a repository with no code graph (not ingested, or not this project's)", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
    serveSymbols([sym("src/app.ts", "g2")]);
    await expect(scopeHasIndexedSourceCode("p1", "repo-1")).resolves.toBe(false);
    expect(mockPrisma.codeSymbol.findMany).not.toHaveBeenCalled();
  });

  it("does not swallow a database failure", async () => {
    mockPrisma.codeGraph.findFirst.mockRejectedValue(new Error("db down"));
    await expect(scopeHasIndexedSourceCode("p1", "repo-1")).rejects.toThrow("db down");
  });
});
