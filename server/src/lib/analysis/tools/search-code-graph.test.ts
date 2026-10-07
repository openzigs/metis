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
/**
 * `mockCodeSymbol.named` answers the `calls`/`calledBy` NAME lookup (#774): it
 * returns the one symbol the name resolves to, or null. The lookup is a
 * `findMany` whose select includes `name`; the result listing's does not.
 */
const mockCodeSymbol = { findMany: vi.fn(), named: vi.fn() };
const mockCodeEdge = { findMany: vi.fn(), count: vi.fn() };

vi.mock("../../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: (...a: unknown[]) => mockCodeGraph.findFirst(...a) },
    codeSymbol: {
      findMany: async (q: { select?: { name?: boolean }; where: { OR?: unknown[] } }) => {
        if (!q.select?.name) return mockCodeSymbol.findMany(q);
        // Exact tier only; the substring tier then finds nothing either.
        if (!q.where.OR) return [];
        const hit = (await mockCodeSymbol.named(q)) as { id: string } | null;
        if (!hit) return [];
        const ref = (q.where.OR[0] as { qualifiedName: string }).qualifiedName;
        return [
          {
            name: ref,
            qualifiedName: ref,
            kind: "function",
            filePath: "x.go",
            startLine: 1,
            endLine: 2,
            language: "go",
            ...hit,
          },
        ];
      },
    },
    codeEdge: {
      findMany: (...a: unknown[]) => mockCodeEdge.findMany(...a),
      count: (...a: unknown[]) => mockCodeEdge.count(...a),
    },
  },
}));

import { searchCodeGraphTool } from "./search-code-graph.js";

const ctx = { projectId: "p1" };

describe("search_code_graph tool — file:line provenance (#715)", () => {
  beforeEach(() => {
    mockCodeGraph.findFirst.mockReset();
    mockCodeSymbol.findMany.mockReset();
    mockCodeSymbol.named.mockReset();
    mockCodeEdge.findMany.mockReset();
    mockCodeEdge.count.mockReset();
    mockCodeEdge.count.mockResolvedValue(0);
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
    mockCodeSymbol.named.mockResolvedValue({ id: "caller1" }); // the named caller
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
    mockCodeSymbol.named.mockResolvedValue(null);
    const res = await searchCodeGraphTool.execute({ calledBy: "Ghost" }, ctx);
    expect(res.content).toBe('No symbol matching "Ghost" found.');
  });

  it("calledBy: reports cleanly when the caller calls nothing", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.named.mockResolvedValue({ id: "caller1" });
    mockCodeEdge.findMany.mockResolvedValue([]);
    const res = await searchCodeGraphTool.execute({ calledBy: "Leaf" }, ctx);
    expect(res.content).toBe('"Leaf" does not call any other symbols.');
  });

  it("calls: resolves callers and renders their locators", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.named.mockResolvedValue({ id: "callee1" });
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
    mockCodeSymbol.named.mockResolvedValue({ id: "callee1" });
    mockCodeEdge.findMany.mockResolvedValue([]);
    const res = await searchCodeGraphTool.execute({ calls: "helper" }, ctx);
    expect(res.content).toBe('No symbols call "helper".');
  });

  it("calls: reports cleanly when the named callee does not exist", async () => {
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.named.mockResolvedValue(null);
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

// ---------------------------------------------------------------------------
// #740 — `calledBy` on a symbol with UNRESOLVED callees (NULL toSymbolId).
//
// The mocks below behave like Prisma rather than like stubs: the edge table is a
// fixture filtered by the `where` the tool actually sends (including the
// `toSymbolId` null / not-null filter and `take`), and `codeSymbol.findMany`
// rejects a NULL member of `id.in` exactly as Prisma does ("Argument `in` is
// missing."). So a regression to passing nulls through is a thrown error here,
// as it was in production.
// ---------------------------------------------------------------------------

interface EdgeRow {
  fromSymbolId: string;
  kind: string;
  toSymbolId: string | null;
  toQualifiedName: string | null;
}

interface EdgeWhere {
  fromSymbolId?: string;
  toSymbolId?: string | null | { not: null };
  kind?: string;
}

function matchEdge(e: EdgeRow, where: EdgeWhere): boolean {
  if (where.fromSymbolId !== undefined && e.fromSymbolId !== where.fromSymbolId) return false;
  if (where.kind !== undefined && e.kind !== where.kind) return false;
  const t = where.toSymbolId;
  if (t === null && e.toSymbolId !== null) return false;
  if (t && typeof t === "object" && e.toSymbolId === null) return false;
  if (typeof t === "string" && e.toSymbolId !== t) return false;
  return true;
}

function useEdgeTable(rows: EdgeRow[]): void {
  mockCodeEdge.findMany.mockImplementation(
    async (q: {
      where: EdgeWhere & { toQualifiedName?: { not: null } };
      take?: number;
      distinct?: string[];
      orderBy?: { toQualifiedName?: "asc" };
    }) => {
      let out = rows.filter((e) => matchEdge(e, q.where));
      if (q.where.toQualifiedName) out = out.filter((e) => e.toQualifiedName !== null);
      if (q.orderBy?.toQualifiedName) {
        out = [...out].sort((a, b) =>
          (a.toQualifiedName ?? "").localeCompare(b.toQualifiedName ?? ""),
        );
      }
      for (const field of (q.distinct ?? []) as (keyof EdgeRow)[]) {
        const seen = new Set<string | null>();
        out = out.filter((e) => !seen.has(e[field]) && !!seen.add(e[field]));
      }
      return q.take === undefined ? out : out.slice(0, q.take);
    },
  );
  mockCodeEdge.count.mockImplementation(
    async (q: { where: EdgeWhere }) => rows.filter((e) => matchEdge(e, q.where)).length,
  );
}

const SYMBOLS: Record<string, { qualifiedName: string; startLine: number }> = {
  r1: { qualifiedName: "internal/storage.go::Storage.Get", startLine: 10 },
  r2: { qualifiedName: "internal/storage.go::Storage.Put", startLine: 30 },
};

function useSymbolTable(): void {
  mockCodeSymbol.findMany.mockImplementation(async (q: { where: { id?: { in: unknown[] } } }) => {
    const ids = q.where.id?.in ?? [];
    if (ids.some((id) => id === null || id === undefined)) {
      // What Prisma does with a NULL member of `in` (#740 production error).
      throw new Error(
        "Invalid `prisma.codeSymbol.findMany()` invocation: Argument `in` is missing.",
      );
    }
    return (ids as string[])
      .filter((id) => SYMBOLS[id])
      .map((id) => ({
        qualifiedName: SYMBOLS[id].qualifiedName,
        kind: "method",
        filePath: "internal/storage.go",
        startLine: SYMBOLS[id].startLine,
        endLine: SYMBOLS[id].startLine + 5,
        language: "go",
      }));
  });
}

const call = (toSymbolId: string | null, toQualifiedName: string | null): EdgeRow => ({
  fromSymbolId: "caller1",
  kind: "calls",
  toSymbolId,
  toQualifiedName,
});

describe("search_code_graph calledBy — unresolved callees (#740)", () => {
  beforeEach(() => {
    mockCodeGraph.findFirst.mockReset();
    mockCodeSymbol.findMany.mockReset();
    mockCodeSymbol.named.mockReset();
    mockCodeEdge.findMany.mockReset();
    mockCodeEdge.count.mockReset();
    mockCodeGraph.findFirst.mockResolvedValue({ id: "g1" });
    mockCodeSymbol.named.mockResolvedValue({ id: "caller1" });
    useSymbolTable();
  });

  it("returns the resolved callees of a mixed caller, with no Prisma error, and names the unresolved ones", async () => {
    useEdgeTable([
      call(null, "fmt.Sprintf"),
      call("r1", "internal/storage.go::Storage.Get"),
      call(null, "errors.New"),
      call("r2", "internal/storage.go::Storage.Put"),
      call(null, "fmt.Sprintf"),
    ]);

    const res = await searchCodeGraphTool.execute({ calledBy: "Handler.Serve" }, ctx);

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain(
      "method internal/storage.go::Storage.Get — internal/storage.go:10-15 [go]",
    );
    expect(res.content).toContain(
      "method internal/storage.go::Storage.Put — internal/storage.go:30-35 [go]",
    );
    expect(res.resultCount).toBe(2);
    // The model is told the external calls exist — three call edges, two names.
    expect(res.content).toContain("plus 3 calls to external or unresolved symbols");
    expect(res.content).toContain("fmt.Sprintf");
    expect(res.content).toContain("errors.New");
  });

  it("all-unresolved callees: a non-error result that says so, not 'does not call any other symbols'", async () => {
    useEdgeTable([call(null, "fmt.Println"), call(null, "database/sql.Open")]);

    const res = await searchCodeGraphTool.execute({ calledBy: "main" }, ctx);

    expect(res.isError).toBeFalsy();
    expect(res.content).not.toContain("does not call any other symbols");
    expect(res.content).toContain("2 calls to external or unresolved symbols");
    expect(res.content).toContain("fmt.Println");
    expect(res.content).toContain("database/sql.Open");
    expect(res.resultCount).toBe(0);
    expect(mockCodeSymbol.findMany).not.toHaveBeenCalled();
  });

  it("applies the result cap AFTER dropping unresolved edges (first N edges all external)", async () => {
    const external = Array.from({ length: 40 }, (_, i) =>
      call(null, `pkg.F${String(39 - i).padStart(2, "0")}`),
    );
    useEdgeTable([...external, call("r1", "internal/storage.go::Storage.Get")]);

    const res = await searchCodeGraphTool.execute({ calledBy: "Big" }, ctx);

    expect(res.content).toContain("internal/storage.go::Storage.Get");
    expect(res.resultCount).toBe(1);
    expect(res.content).toContain("plus 40 calls to external or unresolved symbols");
    // The name list is capped too, and says it was cut.
    // Listed alphabetically, first 20 only: F00..F19 shown, F20 onward cut.
    expect(res.content).toContain("pkg.F00");
    expect(res.content).toContain("pkg.F19");
    expect(res.content).not.toContain("pkg.F20");
    expect(res.content).not.toContain("pkg.F39");
    expect(res.content).toMatch(/…|and more/);
  });

  it("an unresolved edge with no recorded name is still counted", async () => {
    useEdgeTable([call(null, null)]);
    const res = await searchCodeGraphTool.execute({ calledBy: "Anon" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("1 call to external or unresolved symbols");
    expect(res.content).not.toContain("null");
  });

  it("keeps the unresolved note when the other filters exclude every resolved callee", async () => {
    // r-gone is a resolved edge whose symbol the symbol query does not return
    // (e.g. excluded by a `kind` filter alongside `calledBy`).
    useEdgeTable([call("r-gone", "x::Gone"), call(null, "fmt.Errorf")]);
    const res = await searchCodeGraphTool.execute({ calledBy: "Mixed", kind: "class" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("No symbols found matching the query.");
    expect(res.content).toContain("1 call to external or unresolved symbols");
    expect(res.content).toContain("fmt.Errorf");
  });

  it("caps DISTINCT callees: repeated calls to one callee do not use up the slots, and truncation is flagged", async () => {
    const many: Record<string, { qualifiedName: string; startLine: number }> = {};
    const rows: EdgeRow[] = [];
    for (let i = 0; i < 40; i++) {
      const id = `m${i}`;
      many[id] = { qualifiedName: `pkg.go::F${i}`, startLine: i };
      // every callee is called 5 times
      for (let k = 0; k < 5; k++) rows.push(call(id, `pkg.go::F${i}`));
    }
    useEdgeTable(rows);
    mockCodeSymbol.findMany.mockImplementation(
      async (q: { where: { id: { in: string[] } }; take?: number }) =>
        [...new Set(q.where.id.in)]
          .map((id) => ({
            qualifiedName: many[id].qualifiedName,
            kind: "function",
            filePath: "pkg.go",
            startLine: many[id].startLine,
            endLine: many[id].startLine + 1,
            language: "go",
          }))
          .slice(0, q.take),
    );

    const res = await searchCodeGraphTool.execute({ calledBy: "Chatty" }, ctx);

    expect(res.resultCount).toBe(30);
    expect(res.truncated).toBe(true);
  });

  it("calls: repeated calls from one caller do not use up the slots", async () => {
    const callers = Array.from({ length: 3 }, (_, i) => `c${i}`);
    const rows: EdgeRow[] = [];
    for (let k = 0; k < 40; k++)
      rows.push({
        fromSymbolId: "c0",
        kind: "calls",
        toSymbolId: "caller1",
        toQualifiedName: null,
      });
    rows.push({ fromSymbolId: "c1", kind: "calls", toSymbolId: "caller1", toQualifiedName: null });
    rows.push({ fromSymbolId: "c2", kind: "calls", toSymbolId: "caller1", toQualifiedName: null });
    useEdgeTable(rows);
    mockCodeSymbol.findMany.mockImplementation(async (q: { where: { id: { in: string[] } } }) =>
      [...new Set(q.where.id.in)].map((id) => ({
        qualifiedName: id,
        kind: "function",
        filePath: "a.go",
        startLine: 1,
        endLine: 2,
        language: "go",
      })),
    );
    const res = await searchCodeGraphTool.execute({ calls: "x" }, ctx);
    expect(res.resultCount).toBe(callers.length);
  });

  it("calledBy + calls: the calledBy unresolved note is not attached to the calls result", async () => {
    useEdgeTable([
      call("r1", "internal/storage.go::Storage.Get"),
      call(null, "fmt.Errorf"),
      { fromSymbolId: "r2", kind: "calls", toSymbolId: "caller1", toQualifiedName: null },
    ]);
    const res = await searchCodeGraphTool.execute({ calledBy: "A", calls: "B" }, ctx);
    expect(res.content).not.toContain("external or unresolved");
  });

  it("a caller with no call edges at all still reports that it calls nothing", async () => {
    useEdgeTable([]);
    const res = await searchCodeGraphTool.execute({ calledBy: "Leaf" }, ctx);
    expect(res.content).toBe('"Leaf" does not call any other symbols.');
  });
});
