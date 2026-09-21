/**
 * Issue #323 — Integration test that runs the full Code Discovery ingest
 * pipeline against the real Metis monorepo (this very repository).
 *
 * Asserts ingest produces ≥1000 symbols and ≥5000 edges across `server/src`
 * + `ui/src` (per #298 acceptance bar). Gated behind RUN_INTEGRATION_TESTS=1
 * — see `pnpm test:integration`. Prisma is fully mocked, so the assertion
 * is a pure function of the parsers — no DB required.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { ingestCodeGraph } from "../../src/lib/code-graph/ingest.js";

const RUN = process.env.RUN_INTEGRATION_TESTS === "1";
const describeMaybe = RUN ? describe : describe.skip;

interface Row {
  id: string;
  [k: string]: unknown;
}

function makePrismaMock() {
  const codeGraphs: Row[] = [];
  // For codeSymbols / codeEdges we use a Map keyed by id plus a secondary
  // index on `filePath`, so the per-file deleteMany the ingest pipeline
  // issues at the start of every file's processing stays O(rows-for-that-file)
  // instead of O(total-rows). Without this the integration test goes
  // quadratic and times out at >100k edges.
  const codeSymbolMap = new Map<string, Row>();
  const codeSymbolByFile = new Map<string, Set<string>>();
  const codeEdgeMap = new Map<string, Row>();
  const codeEdgeByFile = new Map<string, Set<string>>();
  const findings: Row[] = [];
  const analyses: Row[] = [];
  const agentResults: Row[] = [];
  let idSeq = 0;
  const nextId = () => `id_${++idSeq}`;
  const indexInsert = (
    map: Map<string, Set<string>>,
    key: string | undefined,
    id: string,
  ): void => {
    if (!key) return;
    let s = map.get(key);
    if (!s) {
      s = new Set<string>();
      map.set(key, s);
    }
    s.add(id);
  };
  const matchWhere = (row: any, where: any): boolean => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v === null) {
        if (row[k] !== null && row[k] !== undefined) return false;
      } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        if ("contains" in (v as any)) {
          if (!String(row[k] ?? "").includes((v as any).contains)) return false;
        } else if ("in" in (v as any)) {
          if (!(v as any).in.includes(row[k])) return false;
        } else if ("not" in (v as any)) {
          if (row[k] === (v as any).not) return false;
        }
      } else if (row[k] !== v) {
        return false;
      }
    }
    return true;
  };
  const allSymbols = (): Row[] => Array.from(codeSymbolMap.values());
  const allEdges = (): Row[] => Array.from(codeEdgeMap.values());
  const prisma: any = {
    codeGraph: {
      findFirst: vi.fn(
        async ({ where }: any) => codeGraphs.find((r) => matchWhere(r, where)) ?? null,
      ),
      create: vi.fn(async ({ data, select }: any) => {
        const row: Row = { id: nextId(), ...data };
        codeGraphs.push(row);
        return select ? { id: row.id } : row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = codeGraphs.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    codeSymbol: {
      findMany: vi.fn(async ({ where, select }: any) =>
        allSymbols()
          .filter((r) => matchWhere(r, where))
          .map((r) => {
            if (!select) return r;
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = (r as any)[k];
            return out;
          }),
      ),
      findFirst: vi.fn(async ({ where, select }: any) => {
        const row = allSymbols().find((r) => matchWhere(r, where));
        if (!row) return null;
        if (!select) return row;
        const out: any = {};
        for (const k of Object.keys(select)) out[k] = (row as any)[k];
        return out;
      }),
      create: vi.fn(async ({ data, select }: any) => {
        const row: Row = { id: nextId(), ...data };
        codeSymbolMap.set(row.id, row);
        indexInsert(codeSymbolByFile, (row as any).filePath, row.id);
        return select ? { id: row.id } : row;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        // Fast path: targeted by filePath (the only delete pattern in
        // ingest.persistParsed). Falls back to full scan otherwise.
        const fp = (where as any)?.filePath;
        if (typeof fp === "string") {
          const ids = codeSymbolByFile.get(fp);
          if (ids) {
            for (const id of ids) {
              const row = codeSymbolMap.get(id);
              if (row && matchWhere(row, where)) codeSymbolMap.delete(id);
            }
            codeSymbolByFile.delete(fp);
          }
          return { count: 0 };
        }
        for (const [id, row] of codeSymbolMap) {
          if (matchWhere(row, where)) codeSymbolMap.delete(id);
        }
        return { count: 0 };
      }),
      count: vi.fn(
        async ({ where }: any) => allSymbols().filter((r) => matchWhere(r, where)).length,
      ),
      groupBy: vi.fn(async ({ where, by }: any) => {
        const filtered = allSymbols().filter((r) => matchWhere(r, where));
        const counts = new Map<string, number>();
        for (const row of filtered) {
          const key = (row as any)[by[0]] ?? "";
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts.entries()].map(([k, n]) => ({ [by[0]]: k, _count: { _all: n } }));
      }),
    },
    codeEdge: {
      findMany: vi.fn(async ({ where }: any) => allEdges().filter((r) => matchWhere(r, where))),
      create: vi.fn(async ({ data }: any) => {
        const row: Row = { id: nextId(), ...data };
        codeEdgeMap.set(row.id, row);
        indexInsert(codeEdgeByFile, (row as any).filePath, row.id);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const fp = (where as any)?.filePath;
        if (typeof fp === "string") {
          const ids = codeEdgeByFile.get(fp);
          if (ids) {
            for (const id of ids) {
              const row = codeEdgeMap.get(id);
              if (row && matchWhere(row, where)) codeEdgeMap.delete(id);
            }
            codeEdgeByFile.delete(fp);
          }
          return { count: 0 };
        }
        for (const [id, row] of codeEdgeMap) {
          if (matchWhere(row, where)) codeEdgeMap.delete(id);
        }
        return { count: 0 };
      }),
      count: vi.fn(async ({ where }: any) => allEdges().filter((r) => matchWhere(r, where)).length),
    },
    finding: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => {
        const row: Row = { id: nextId(), ...data };
        findings.push(row);
        return row;
      }),
    },
    analysis: {
      create: vi.fn(async ({ data, select }: any) => {
        const row: Row = { id: nextId(), ...data };
        analyses.push(row);
        return select ? { id: row.id } : row;
      }),
    },
    agentResult: {
      create: vi.fn(async ({ data, select }: any) => {
        const row: Row = { id: nextId(), ...data };
        agentResults.push(row);
        return select ? { id: row.id } : row;
      }),
    },
  };
  return {
    prisma,
    get codeSymbols() {
      return allSymbols();
    },
    get codeEdges() {
      return allEdges();
    },
  };
}

describeMaybe("Code Discovery — real-repo integration (#323)", () => {
  it("ingests the metis monorepo and produces ≥1000 symbols, ≥5000 edges", async () => {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    // server/tests/integration → ../../.. = repo root
    const repoRoot = path.resolve(here, "..", "..", "..");
    const mock = makePrismaMock();
    const { prisma } = mock;
    const stats = await ingestCodeGraph(prisma, {
      projectId: "integration-project",
      rootDir: repoRoot,
      incremental: false,
    });
    // Snapshot AFTER the ingest \u2014 mock.codeSymbols/codeEdges are getters that
    // materialise the current Map contents on each access.
    const codeSymbols = mock.codeSymbols;
    const codeEdges = mock.codeEdges;
    // Issue #383 — break the count down by edge kind so the in-degree-feeding
    // edges (calls + references) have their own gate.
    const byKind = new Map<string, number>();
    let resolved = 0;
    for (const e of codeEdges) {
      const k = (e as { kind: string }).kind;
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
      if ((e as { toSymbolId: string | null }).toSymbolId) resolved += 1;
    }
    const calls = byKind.get("calls") ?? 0;
    const refs = byKind.get("references") ?? 0;
    // eslint-disable-next-line no-console
    console.log(
      `[#323/#383] files=${stats.filesParsed}/${stats.filesScanned} skipped=${stats.filesSkipped} ` +
        `symbols=${codeSymbols.length} edges=${codeEdges.length} ` +
        `calls=${calls} references=${refs} resolved=${resolved}`,
    );
    expect(stats.filesParsed).toBeGreaterThan(50);
    expect(codeSymbols.length).toBeGreaterThanOrEqual(1000);
    expect(codeEdges.length).toBeGreaterThanOrEqual(5000);
    // #383 — calls + references combined must clear 5k so the in-degree
    // ranking has real data to rank against.
    expect(calls + refs).toBeGreaterThanOrEqual(5000);
    // #383 — at least some edges must resolve to a real `toSymbolId`,
    // otherwise the project-overview god-node ranking will render empty
    // (the bug this issue was filed to fix).
    expect(resolved).toBeGreaterThan(1000);
  }, 120_000);
});
