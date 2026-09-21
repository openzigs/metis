/**
 * Epic #712 / Issue #715 — search_code_graph tool-result provenance tests.
 *
 * Guards AC #2: every symbol returned to the model carries the same
 * `filePath:startLine-endLine` locator (the authoritative `CodeSymbol` spans),
 * so the model can cite exact source locations rather than emitting a vague
 * "reconstructed from the knowledge base" disclaimer. Prisma is mocked so the
 * test never touches a live DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCodeGraph = { findFirst: vi.fn() };
const mockCodeSymbol = { findMany: vi.fn(), findFirst: vi.fn() };
const mockCodeEdge = { findMany: vi.fn() };

vi.mock("../../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: (...a: unknown[]) => mockCodeGraph.findFirst(...a) },
    codeSymbol: {
      findMany: (...a: unknown[]) => mockCodeSymbol.findMany(...a),
      findFirst: (...a: unknown[]) => mockCodeSymbol.findFirst(...a),
    },
    codeEdge: { findMany: (...a: unknown[]) => mockCodeEdge.findMany(...a) },
  },
}));

import { searchCodeGraphTool } from "./search-code-graph.js";

const ctx = { projectId: "p1" };

describe("search_code_graph tool — file:line provenance (#715)", () => {
  beforeEach(() => {
    mockCodeGraph.findFirst.mockReset();
    mockCodeSymbol.findMany.mockReset();
    mockCodeSymbol.findFirst.mockReset();
    mockCodeEdge.findMany.mockReset();
  });

  it("renders each symbol with its authoritative filePath:startLine-endLine locator", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.findMany.mockResolvedValue([
      {
        qualifiedName: "server/src/foo.ts::Foo.bar",
        kind: "method",
        filePath: "server/src/foo.ts",
        startLine: 12,
        endLine: 40,
        language: "typescript",
      },
      {
        qualifiedName: "server/src/baz.ts::Baz",
        kind: "class",
        filePath: "server/src/baz.ts",
        startLine: 3,
        endLine: 3,
        language: "typescript",
      },
    ]);

    const res = await searchCodeGraphTool.execute({ query: "Foo" }, ctx);

    // The exact locator format the model is told to cite — line spans are used
    // verbatim from CodeSymbol.startLine/endLine (no off-by-one).
    expect(res.content).toContain(
      "method server/src/foo.ts::Foo.bar — server/src/foo.ts:12-40 [typescript]",
    );
    // A single-line symbol renders start === end, never a fabricated range.
    expect(res.content).toContain(
      "class server/src/baz.ts::Baz — server/src/baz.ts:3-3 [typescript]",
    );
    expect(res.truncated).toBe(false);
  });

  it("degrades cleanly (no fabricated locator) when the project has no code graph", async () => {
    mockCodeGraph.findFirst.mockResolvedValue(null);
    const res = await searchCodeGraphTool.execute({ query: "Foo" }, ctx);
    expect(res.content).toBe("No code graph available for this project.");
    // No file:line locator is invented when there is nothing to ground on.
    expect(res.content).not.toMatch(/:\d+-\d+/);
    expect(mockCodeSymbol.findMany).not.toHaveBeenCalled();
  });

  it("returns a plain no-match result (no locator) when the query matches no symbol", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.findMany.mockResolvedValue([]);
    const res = await searchCodeGraphTool.execute({ query: "Nope" }, ctx);
    expect(res.content).toBe("No symbols found matching the query.");
    expect(res.content).not.toMatch(/:\d+-\d+/);
  });

  it("calledBy: resolves callees and still renders their filePath:startLine-endLine locators", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.findFirst.mockResolvedValue({ id: "caller1" }); // the named caller
    mockCodeEdge.findMany.mockResolvedValue([{ toSymbolId: "callee1" }]);
    mockCodeSymbol.findMany.mockResolvedValue([
      {
        qualifiedName: "server/src/dep.ts::helper",
        kind: "function",
        filePath: "server/src/dep.ts",
        startLine: 7,
        endLine: 9,
        language: "typescript",
      },
    ]);

    const res = await searchCodeGraphTool.execute({ calledBy: "Foo.bar" }, ctx);
    expect(res.content).toContain(
      "function server/src/dep.ts::helper — server/src/dep.ts:7-9 [typescript]",
    );
  });

  it("calledBy: reports cleanly when the named caller does not exist", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.findFirst.mockResolvedValue(null);
    const res = await searchCodeGraphTool.execute({ calledBy: "Ghost" }, ctx);
    expect(res.content).toBe('No symbol matching "Ghost" found.');
  });

  it("calledBy: reports cleanly when the caller calls nothing", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.findFirst.mockResolvedValue({ id: "caller1" });
    mockCodeEdge.findMany.mockResolvedValue([]);
    const res = await searchCodeGraphTool.execute({ calledBy: "Leaf" }, ctx);
    expect(res.content).toBe('"Leaf" does not call any other symbols.');
  });

  it("calls: resolves callers and renders their locators", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.findFirst.mockResolvedValue({ id: "callee1" });
    mockCodeEdge.findMany.mockResolvedValue([{ fromSymbolId: "caller1" }]);
    mockCodeSymbol.findMany.mockResolvedValue([
      {
        qualifiedName: "server/src/root.ts::main",
        kind: "function",
        filePath: "server/src/root.ts",
        startLine: 1,
        endLine: 20,
        language: "typescript",
      },
    ]);

    const res = await searchCodeGraphTool.execute({ calls: "helper" }, ctx);
    expect(res.content).toContain(
      "function server/src/root.ts::main — server/src/root.ts:1-20 [typescript]",
    );
  });

  it("calls: reports cleanly when no symbol calls the target", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.findFirst.mockResolvedValue({ id: "callee1" });
    mockCodeEdge.findMany.mockResolvedValue([]);
    const res = await searchCodeGraphTool.execute({ calls: "helper" }, ctx);
    expect(res.content).toBe('No symbols call "helper".');
  });

  it("calls: reports cleanly when the named callee does not exist", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.findFirst.mockResolvedValue(null);
    const res = await searchCodeGraphTool.execute({ calls: "Ghost" }, ctx);
    expect(res.content).toBe('No symbol matching "Ghost" found.');
  });

  it("#774: refuses an UNFILTERED query and returns filter guidance instead of symbols", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.findMany.mockResolvedValue([
      {
        qualifiedName: "AAA.first",
        kind: "class",
        filePath: "a.ts",
        startLine: 1,
        endLine: 2,
        language: "typescript",
      },
    ]);

    const res = await searchCodeGraphTool.execute({}, ctx);

    // On main this returned the first 30 symbols ALPHABETICALLY — fixed,
    // plausible-looking poison the agent treated as real evidence (#773).
    expect(mockCodeSymbol.findMany).not.toHaveBeenCalled();
    expect(res.content).not.toContain("AAA.first");
    expect(res.content).toContain("Error:");
    // The guidance names every real filter so the model can self-repair.
    for (const filter of ["query", "kind", "filePath", "calledBy", "calls"]) {
      expect(res.content).toContain(filter);
    }
  });

  it("#774: an unfiltered call reports the keys it actually received", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    const res = await searchCodeGraphTool.execute({ q: "severity", foo: 1 }, ctx);
    expect(res.content).toContain("received keys: [q, foo]");
    expect(mockCodeSymbol.findMany).not.toHaveBeenCalled();
  });

  it("#774: a call with ANY real filter still executes (regression)", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.findMany.mockResolvedValue([]);
    const res = await searchCodeGraphTool.execute({ kind: "class" }, ctx);
    expect(mockCodeSymbol.findMany).toHaveBeenCalled();
    expect(res.content).toBe("No symbols found matching the query.");
  });

  it("flags truncation when the result set hits the cap", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    const many = Array.from({ length: 30 }, (_, i) => ({
      qualifiedName: `server/src/f${i}.ts::S${i}`,
      kind: "class",
      filePath: `server/src/f${i}.ts`,
      startLine: i + 1,
      endLine: i + 2,
      language: "typescript",
    }));
    mockCodeSymbol.findMany.mockResolvedValue(many);
    const res = await searchCodeGraphTool.execute({ kind: "class" }, ctx);
    expect(res.truncated).toBe(true);
    expect(res.content).toContain("server/src/f0.ts:1-2");
  });
});
