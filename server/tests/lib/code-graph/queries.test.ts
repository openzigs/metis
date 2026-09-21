/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Issue #310 — MCP code-graph query tool tests.
 *
 * The query implementations live in the wrapper image at
 * `images/mcp-wrappers/code-graph-runner-sse/queries/` (so the runtime image
 * can `COPY` them in). The tests reach across the workspace boundary via a
 * relative import path. The functions are pure — they take a Prisma-shaped
 * object as their first argument — so we hand them a hand-rolled mock here
 * rather than wiring up `vi.mock` on the singleton.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { getCallGraph } from "../../../../images/mcp-wrappers/code-graph-runner-sse/queries/get_call_graph.js";
import { whoCalls } from "../../../../images/mcp-wrappers/code-graph-runner-sse/queries/who_calls.js";
import { definedIn } from "../../../../images/mcp-wrappers/code-graph-runner-sse/queries/defined_in.js";
import { importsOf } from "../../../../images/mcp-wrappers/code-graph-runner-sse/queries/imports_of.js";
import { outline } from "../../../../images/mcp-wrappers/code-graph-runner-sse/queries/outline.js";

interface MockSymbolRow {
  id: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
  name?: string;
  projectId?: string;
}

interface MockEdgeRow {
  id: string;
  fromSymbolId: string;
  toSymbolId: string | null;
  toQualifiedName: string | null;
  kind: string;
  line: number;
  filePath: string;
  metadata: string | null;
  fromSymbol?: { qualifiedName: string };
  toSymbol?: {
    id: string;
    qualifiedName: string;
    kind: string;
    filePath: string;
    startLine: number;
  } | null;
}

function makePrisma(symbols: MockSymbolRow[], edges: MockEdgeRow[]) {
  return {
    codeSymbol: {
      findMany: vi.fn(async ({ where, select, orderBy }: any) => {
        let rows = symbols.filter((s) => {
          if (where.projectId && s.projectId && s.projectId !== where.projectId) return false;
          if (where.filePath && s.filePath !== where.filePath) return false;
          if (where.qualifiedName && s.qualifiedName !== where.qualifiedName) return false;
          return true;
        });
        if (orderBy?.startLine === "asc") {
          rows = [...rows].sort((a, b) => a.startLine - b.startLine);
        }
        return rows.map((r) => projectFields(r, select));
      }),
      findFirst: vi.fn(async ({ where, select }: any) => {
        const hit = symbols.find((s) => {
          if (where.projectId && s.projectId && s.projectId !== where.projectId) return false;
          if (where.qualifiedName && s.qualifiedName !== where.qualifiedName) return false;
          return true;
        });
        return hit ? projectFields(hit, select) : null;
      }),
    },
    codeEdge: {
      findMany: vi.fn(async ({ where, select, take, cursor, skip }: any) => {
        let rows = edges.filter((e) => {
          if (where.projectId !== undefined && false) return false; // not used in mock
          if (where.kind?.in && !where.kind.in.includes(e.kind)) return false;
          if (where.kind && typeof where.kind === "string" && e.kind !== where.kind) return false;
          if (where.filePath && e.filePath !== where.filePath) return false;
          if (where.fromSymbolId?.in && !where.fromSymbolId.in.includes(e.fromSymbolId))
            return false;
          if (
            where.toSymbolId?.in &&
            (!e.toSymbolId || !where.toSymbolId.in.includes(e.toSymbolId))
          )
            return false;
          if (where.OR) {
            const matchesAny = where.OR.some((cond: any) => {
              if (cond.toSymbolId?.in)
                return e.toSymbolId !== null && cond.toSymbolId.in.includes(e.toSymbolId);
              if (cond.toQualifiedName) return e.toQualifiedName === cond.toQualifiedName;
              return false;
            });
            if (!matchesAny) return false;
          }
          return true;
        });
        if (cursor?.id) {
          const idx = rows.findIndex((r) => r.id === cursor.id);
          if (idx >= 0) rows = rows.slice(idx + (skip ?? 0));
        }
        if (take) rows = rows.slice(0, take);
        return rows.map((r) => projectFields(r, select));
      }),
    },
  } as any;
}

function projectFields(row: any, select: any): any {
  if (!select) return row;
  const out: any = {};
  for (const [key, val] of Object.entries(select)) {
    if (val === true) out[key] = row[key];
    else if (typeof val === "object" && val !== null) {
      out[key] = row[key] ? projectFields(row[key], (val as any).select ?? val) : null;
    }
  }
  return out;
}

beforeEach(() => vi.clearAllMocks());

describe("getCallGraph (#310)", () => {
  it("returns empty when no symbols match the file", async () => {
    const prisma = makePrisma([], []);
    const result = await getCallGraph(prisma, { file: "missing.ts", projectId: "p" });
    expect(result).toEqual({ nodes: [], edges: [], truncated: false });
  });

  it("walks one hop of outbound calls", async () => {
    const symbols: MockSymbolRow[] = [
      {
        id: "s1",
        qualifiedName: "a.ts::foo",
        kind: "function",
        filePath: "a.ts",
        startLine: 1,
        projectId: "p",
      },
      {
        id: "s2",
        qualifiedName: "b.ts::bar",
        kind: "function",
        filePath: "b.ts",
        startLine: 5,
        projectId: "p",
      },
    ];
    const edges: MockEdgeRow[] = [
      {
        id: "e1",
        fromSymbolId: "s1",
        toSymbolId: "s2",
        toQualifiedName: "b.ts::bar",
        kind: "calls",
        line: 3,
        filePath: "a.ts",
        metadata: null,
        fromSymbol: { qualifiedName: "a.ts::foo" },
        toSymbol: {
          id: "s2",
          qualifiedName: "b.ts::bar",
          kind: "function",
          filePath: "b.ts",
          startLine: 5,
        },
      },
    ];
    const prisma = makePrisma(symbols, edges);
    const result = await getCallGraph(prisma, { file: "a.ts", projectId: "p", depth: 1 });
    expect(result.nodes.map((n) => n.qualifiedName).sort()).toEqual(["a.ts::foo", "b.ts::bar"]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].from).toBe("a.ts::foo");
    expect(result.edges[0].to).toBe("b.ts::bar");
    expect(result.truncated).toBe(false);
  });

  it("flags truncated when maxNodes is exceeded", async () => {
    const seedSymbols: MockSymbolRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      qualifiedName: `a.ts::f${i}`,
      kind: "function",
      filePath: "a.ts",
      startLine: i + 1,
      projectId: "p",
    }));
    const prisma = makePrisma(seedSymbols, []);
    const result = await getCallGraph(prisma, { file: "a.ts", projectId: "p", maxNodes: 2 });
    expect(result.truncated).toBe(true);
    expect(result.nodes).toHaveLength(2);
  });

  it("rejects invalid input via Zod", async () => {
    const prisma = makePrisma([], []);
    await expect(getCallGraph(prisma, { file: "", projectId: "p" })).rejects.toThrow();
    await expect(
      getCallGraph(prisma, { file: "a.ts", projectId: "p", depth: 99 }),
    ).rejects.toThrow();
  });
});

describe("whoCalls (#310)", () => {
  it("returns callers of a known symbol", async () => {
    const symbols: MockSymbolRow[] = [
      {
        id: "s1",
        qualifiedName: "x.ts::target",
        kind: "function",
        filePath: "x.ts",
        startLine: 1,
        projectId: "p",
      },
    ];
    const edges: MockEdgeRow[] = [
      {
        id: "e1",
        fromSymbolId: "fa",
        toSymbolId: "s1",
        toQualifiedName: "x.ts::target",
        kind: "calls",
        line: 9,
        filePath: "caller.ts",
        metadata: null,
        fromSymbol: { qualifiedName: "caller.ts::a" },
      },
    ];
    const prisma = makePrisma(symbols, edges);
    const result = await whoCalls(prisma, { symbol: "x.ts::target", projectId: "p" });
    expect(result.callers).toEqual([
      { filePath: "caller.ts", line: 9, callerSymbol: "caller.ts::a" },
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it("returns hits for unresolved external targets", async () => {
    const edges: MockEdgeRow[] = [
      {
        id: "e1",
        fromSymbolId: "fa",
        toSymbolId: null,
        toQualifiedName: "ext.lib",
        kind: "calls",
        line: 12,
        filePath: "user.ts",
        metadata: null,
        fromSymbol: { qualifiedName: "user.ts::a" },
      },
    ];
    const prisma = makePrisma([], edges);
    const result = await whoCalls(prisma, { symbol: "ext.lib", projectId: "p" });
    expect(result.callers).toHaveLength(1);
  });

  it("paginates with nextCursor when more rows exist", async () => {
    const targetSym: MockSymbolRow = {
      id: "t1",
      qualifiedName: "x.ts::t",
      kind: "function",
      filePath: "x.ts",
      startLine: 1,
      projectId: "p",
    };
    const edges: MockEdgeRow[] = Array.from({ length: 3 }, (_, i) => ({
      id: `e${i}`,
      fromSymbolId: `fa${i}`,
      toSymbolId: "t1",
      toQualifiedName: "x.ts::t",
      kind: "calls",
      line: i,
      filePath: `caller${i}.ts`,
      metadata: null,
      fromSymbol: { qualifiedName: `caller${i}.ts::a` },
    }));
    const prisma = makePrisma([targetSym], edges);
    const result = await whoCalls(prisma, { symbol: "x.ts::t", projectId: "p", pageSize: 2 });
    expect(result.callers).toHaveLength(2);
    expect(result.nextCursor).toBe("e1");
  });
});

describe("definedIn (#310)", () => {
  it("returns null on unknown symbol", async () => {
    const prisma = makePrisma([], []);
    expect(await definedIn(prisma, { symbol: "nope", projectId: "p" })).toBeNull();
  });

  it("returns filePath + line on hit", async () => {
    const symbols: MockSymbolRow[] = [
      {
        id: "s1",
        qualifiedName: "a.ts::Foo",
        kind: "class",
        filePath: "a.ts",
        startLine: 42,
        projectId: "p",
      },
    ];
    const prisma = makePrisma(symbols, []);
    expect(await definedIn(prisma, { symbol: "a.ts::Foo", projectId: "p" })).toEqual({
      filePath: "a.ts",
      line: 42,
    });
  });
});

describe("importsOf (#310)", () => {
  it("returns outbound and inbound imports", async () => {
    const symbols: MockSymbolRow[] = [
      {
        id: "m1",
        qualifiedName: "a.ts",
        kind: "module",
        filePath: "a.ts",
        startLine: 1,
        projectId: "p",
      },
    ];
    const edges: MockEdgeRow[] = [
      {
        id: "e1",
        fromSymbolId: "m1",
        toSymbolId: null,
        toQualifiedName: "lodash",
        kind: "imports",
        line: 1,
        filePath: "a.ts",
        metadata: JSON.stringify({ typeOnly: true }),
      },
      {
        id: "e2",
        fromSymbolId: "m2",
        toSymbolId: "m1",
        toQualifiedName: "a.ts",
        kind: "imports",
        line: 4,
        filePath: "b.ts",
        metadata: null,
        toSymbol: {
          id: "m1",
          qualifiedName: "a.ts",
          kind: "module",
          filePath: "a.ts",
          startLine: 1,
        },
      },
    ];
    const prisma = makePrisma(symbols, edges);
    const result = await importsOf(prisma, { file: "a.ts", projectId: "p" });
    expect(result.outbound).toHaveLength(1);
    expect(result.outbound[0].typeOnly).toBe(true);
    expect(result.outbound[0].toQualifiedName).toBe("lodash");
    expect(result.inbound).toHaveLength(1);
    expect(result.inbound[0].fromFile).toBe("b.ts");
  });

  it("handles malformed metadata gracefully (typeOnly=false)", async () => {
    const edges: MockEdgeRow[] = [
      {
        id: "e1",
        fromSymbolId: "m1",
        toSymbolId: null,
        toQualifiedName: "lib",
        kind: "imports",
        line: 1,
        filePath: "a.ts",
        metadata: "not-json",
      },
    ];
    const prisma = makePrisma([], edges);
    const result = await importsOf(prisma, { file: "a.ts", projectId: "p" });
    expect(result.outbound[0].typeOnly).toBe(false);
  });
});

describe("outline (#310)", () => {
  it("returns symbols ordered by startLine", async () => {
    const symbols: MockSymbolRow[] = [
      {
        id: "s1",
        name: "foo",
        qualifiedName: "x.ts::foo",
        kind: "function",
        filePath: "x.ts",
        startLine: 10,
        projectId: "p",
      },
      {
        id: "s2",
        name: "Bar",
        qualifiedName: "x.ts::Bar",
        kind: "class",
        filePath: "x.ts",
        startLine: 1,
        projectId: "p",
      },
    ];
    const prisma = makePrisma(symbols, []);
    const result = await outline(prisma, { file: "x.ts", projectId: "p" });
    expect(result.map((r) => r.name)).toEqual(["Bar", "foo"]);
  });

  it("returns empty list for unknown file", async () => {
    const prisma = makePrisma([], []);
    expect(await outline(prisma, { file: "nope.ts", projectId: "p" })).toEqual([]);
  });
});
