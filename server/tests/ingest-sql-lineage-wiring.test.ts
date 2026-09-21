/**
 * Issue #894 (Epic #882 Phase 3) — guards that:
 *   1. `extractSchemaUsage`'s feature gate is per-project-overridable
 *      (`wiring.sqlLineageOverride`), not just the platform `SQL_LINEAGE_MODE`
 *      env flag.
 *   2. Tier-1 catalog-dependency rows (`wiring.dependencies`, #890) are
 *      threaded through into `calls` edges via `extractRoutineDependencies`.
 *
 * The per-file sidecar extractors themselves (embedded SQL / SAS / routine
 * bodies) are covered by their own extractor test files; this test only
 * covers the ingest-level wiring seam #894 added.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fakes */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractSchemaUsage, type IngestStats } from "../src/lib/code-graph/ingest.js";
import type { DbDependencyInfo } from "@metis/shared";

function fakePrisma() {
  const symbols: any[] = [];
  const edges: any[] = [];
  let n = 0;
  const prisma = {
    codeSymbol: {
      create: vi.fn(async ({ data }: any) => {
        symbols.push(data);
        return { id: `sym-${++n}` };
      }),
    },
    codeEdge: {
      create: vi.fn(async ({ data }: any) => {
        edges.push(data);
        return undefined;
      }),
    },
  };
  return { prisma, symbols, edges };
}

const stats = (): IngestStats => ({ schemaEdges: 0, routineEdges: 0 }) as unknown as IngestStats;

const DEP: DbDependencyInfo = {
  schema: "APP",
  name: "PKG_ORDERS",
  type: "PACKAGE",
  referencedSchema: "APP",
  referencedName: "ORDERS",
  referencedType: "TABLE",
};

describe("extractSchemaUsage — per-project SQL-lineage gate (#894)", () => {
  const original = process.env.SQL_LINEAGE_MODE;

  beforeEach(() => {
    process.env.SQL_LINEAGE_MODE = "in-process"; // platform default: disabled
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SQL_LINEAGE_MODE;
    else process.env.SQL_LINEAGE_MODE = original;
  });

  it("skips entirely (no edges) when neither the platform nor the override enable it", async () => {
    const { prisma, edges } = fakePrisma();
    const s = stats();
    await extractSchemaUsage(prisma as any, "graph-1", "proj-1", [], new Map(), s, {
      dependencies: [DEP],
    });
    expect(edges).toHaveLength(0);
    expect(s.routineEdges).toBe(0);
  });

  it("sqlLineageOverride=true forces Tier-1 dependency extraction even when the platform default is off", async () => {
    const { prisma, edges } = fakePrisma();
    const s = stats();
    await extractSchemaUsage(prisma as any, "graph-1", "proj-1", [], new Map(), s, {
      dependencies: [DEP],
      sqlLineageOverride: true,
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ kind: "calls", source: "catalog-deps" });
    expect(JSON.parse(edges[0].metadata)).toEqual({ tier: 1, coarse: true, direction: "unknown" });
    expect(s.routineEdges).toBe(1);
  });

  it("sqlLineageOverride=false forces skip even when the platform default is on", async () => {
    process.env.SQL_LINEAGE_MODE = "sidecar";
    const { prisma, edges } = fakePrisma();
    const s = stats();
    await extractSchemaUsage(prisma as any, "graph-1", "proj-1", [], new Map(), s, {
      dependencies: [DEP],
      sqlLineageOverride: false,
    });
    expect(edges).toHaveLength(0);
    expect(s.routineEdges).toBe(0);
  });

  it("omitting sqlLineageOverride keeps the pre-#894 platform-only gate (enabled)", async () => {
    process.env.SQL_LINEAGE_MODE = "sidecar";
    const { prisma, edges } = fakePrisma();
    const s = stats();
    await extractSchemaUsage(prisma as any, "graph-1", "proj-1", [], new Map(), s, {
      dependencies: [DEP],
    });
    expect(edges).toHaveLength(1);
    expect(s.routineEdges).toBe(1);
  });

  it("a malformed dependency row is skipped, never aborting the rest of ingest", async () => {
    const { prisma, edges } = fakePrisma();
    const s = stats();
    const malformed: DbDependencyInfo = { ...DEP, name: "" };
    await extractSchemaUsage(prisma as any, "graph-1", "proj-1", [], new Map(), s, {
      dependencies: [malformed, DEP],
      sqlLineageOverride: true,
    });
    expect(edges).toHaveLength(1);
  });

  it("no dependencies supplied writes no catalog-deps edges (no regression)", async () => {
    const { prisma, edges } = fakePrisma();
    const s = stats();
    await extractSchemaUsage(prisma as any, "graph-1", "proj-1", [], new Map(), s, {
      sqlLineageOverride: true,
    });
    expect(edges).toHaveLength(0);
  });
});
