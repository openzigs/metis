/**
 * Unit tests — Issue #895 (Epic #882 Phase 3).
 *
 * `classifyCoverageEdge` / `buildSqlLineageCoverage` / `computeSqlLineageCoverage`
 * are the pure counting core that turns the extractors' unresolved-edge markers
 * (#886/#890/#892/#893) into the gap-report coverage metric. Every
 * resolved-vs-unresolved branch (dynamic marker, coarse `catalog-deps`,
 * malformed metadata, empty input, the display cap) is pinned here.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildSqlLineageCoverage,
  classifyCoverageEdge,
  computeSqlLineageCoverage,
  type CoverageEdgeRow,
  type SqlLineageCoveragePrismaClient,
} from "./sql-lineage-coverage.js";
import { SQL_LINEAGE_COVERAGE_MAX_REFS } from "@metis/shared";

function edge(overrides: Partial<CoverageEdgeRow> = {}): CoverageEdgeRow {
  return {
    id: "e1",
    kind: "reads",
    source: "sqlglot",
    metadata: null,
    toQualifiedName: "app.orders",
    filePath: "src/Foo.java",
    ...overrides,
  };
}

const DYNAMIC_META = JSON.stringify({
  unresolved: true,
  placeholder: "tableName",
  statementId: "FooMapper.find",
  mapper: "com.acme.FooMapper",
});

describe("classifyCoverageEdge", () => {
  it("treats a resolved sqlglot edge as resolved", () => {
    expect(classifyCoverageEdge(edge())).toEqual({
      unresolved: false,
      reason: null,
      placeholder: null,
      statementId: null,
      mapper: null,
    });
  });

  it("classifies a dynamic-marker edge as unresolved:dynamic and lifts its fields", () => {
    expect(classifyCoverageEdge(edge({ metadata: DYNAMIC_META }))).toEqual({
      unresolved: true,
      reason: "dynamic",
      placeholder: "tableName",
      statementId: "FooMapper.find",
      mapper: "com.acme.FooMapper",
    });
  });

  it("classifies a catalog-deps edge as unresolved:coarse-catalog", () => {
    const c = classifyCoverageEdge(edge({ source: "catalog-deps", kind: "calls", metadata: null }));
    expect(c.unresolved).toBe(true);
    expect(c.reason).toBe("coarse-catalog");
    expect(c.placeholder).toBeNull();
  });

  it("prefers the dynamic marker over a catalog-deps source when both are present", () => {
    const c = classifyCoverageEdge(edge({ source: "catalog-deps", metadata: DYNAMIC_META }));
    expect(c.reason).toBe("dynamic");
  });

  it("degrades a malformed metadata blob to resolved (never fabricates unresolved)", () => {
    expect(classifyCoverageEdge(edge({ metadata: "{not json" })).unresolved).toBe(false);
  });

  it("ignores a metadata object that is not an unresolved marker (e.g. Tier-1 coarse marker)", () => {
    const meta = JSON.stringify({ tier: 1, coarse: true, direction: "unknown" });
    // With source NOT catalog-deps, a coarse-marker-only edge is resolved (the
    // coarse signal is carried by `source`, not this metadata shape).
    expect(classifyCoverageEdge(edge({ metadata: meta, source: "sqlglot" })).unresolved).toBe(
      false,
    );
  });

  it("tolerates non-string placeholder/statementId/mapper fields (null them out)", () => {
    const meta = JSON.stringify({
      unresolved: true,
      placeholder: 42,
      statementId: null,
      mapper: 7,
    });
    expect(classifyCoverageEdge(edge({ metadata: meta }))).toMatchObject({
      unresolved: true,
      reason: "dynamic",
      placeholder: null,
      statementId: null,
      mapper: null,
    });
  });
});

describe("buildSqlLineageCoverage", () => {
  it("returns null for no edges (report omits the section)", () => {
    expect(buildSqlLineageCoverage([])).toBeNull();
  });

  it("computes resolved/unresolved counts, one-decimal percent, and per-source breakdown", () => {
    const rows = [
      edge({ id: "a", source: "sqlglot" }),
      edge({ id: "b", source: "mybatis", metadata: DYNAMIC_META, kind: "reads" }),
      edge({ id: "c", source: "catalog-deps", kind: "calls", metadata: null }),
      edge({ id: "d", source: "orm", kind: "persists-to" }),
    ];
    const cov = buildSqlLineageCoverage(rows);
    expect(cov).not.toBeNull();
    expect(cov!.totalEdges).toBe(4);
    expect(cov!.resolvedEdges).toBe(2);
    expect(cov!.unresolvedEdges).toBe(2);
    expect(cov!.coveragePercent).toBe(50);
    expect(cov!.bySource).toEqual({
      sqlglot: { total: 1, unresolved: 0 },
      mybatis: { total: 1, unresolved: 1 },
      "catalog-deps": { total: 1, unresolved: 1 },
      orm: { total: 1, unresolved: 0 },
    });
    expect(cov!.unresolvedRefs.map((r) => r.edgeId)).toEqual(["b", "c"]);
    expect(cov!.unresolvedRefs[0]).toMatchObject({ reason: "dynamic", placeholder: "tableName" });
    expect(cov!.unresolvedRefs[1]).toMatchObject({
      reason: "coarse-catalog",
      source: "catalog-deps",
    });
  });

  it("rounds the percentage to one decimal (2 of 3 resolved → 66.7%)", () => {
    const rows = [
      edge({ id: "a" }),
      edge({ id: "b" }),
      edge({ id: "c", source: "catalog-deps", kind: "calls" }),
    ];
    expect(buildSqlLineageCoverage(rows)!.coveragePercent).toBe(66.7);
  });

  it("buckets a null source under 'unknown'", () => {
    const cov = buildSqlLineageCoverage([edge({ id: "a", source: null, metadata: DYNAMIC_META })]);
    expect(cov!.bySource).toEqual({ unknown: { total: 1, unresolved: 1 } });
    expect(cov!.unresolvedRefs[0].source).toBe("unknown");
  });

  it("caps unresolvedRefs at SQL_LINEAGE_COVERAGE_MAX_REFS but keeps the full unresolvedEdges count", () => {
    const n = SQL_LINEAGE_COVERAGE_MAX_REFS + 5;
    const rows = Array.from({ length: n }, (_, i) =>
      edge({ id: `e${i}`, source: "catalog-deps", kind: "calls", metadata: null }),
    );
    const cov = buildSqlLineageCoverage(rows);
    expect(cov!.unresolvedEdges).toBe(n);
    expect(cov!.unresolvedRefs).toHaveLength(SQL_LINEAGE_COVERAGE_MAX_REFS);
    expect(cov!.coveragePercent).toBe(0);
  });
});

describe("computeSqlLineageCoverage", () => {
  it("reads the project's schema lineage edges and folds them into coverage", async () => {
    const rows = [edge({ id: "a" }), edge({ id: "b", source: "catalog-deps", kind: "calls" })];
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma: SqlLineageCoveragePrismaClient = { codeEdge: { findMany } };
    const cov = await computeSqlLineageCoverage("proj-1", prisma);
    expect(cov!.totalEdges).toBe(2);
    expect(cov!.unresolvedEdges).toBe(1);
    // Only the schema lineage edge kinds are queried (denominator = table/object edges).
    expect(findMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1", kind: { in: ["reads", "writes", "persists-to", "calls"] } },
      select: {
        id: true,
        kind: true,
        source: true,
        metadata: true,
        toQualifiedName: true,
        filePath: true,
      },
    });
  });

  it("returns null when the project has no schema lineage edges", async () => {
    const prisma: SqlLineageCoveragePrismaClient = {
      codeEdge: { findMany: vi.fn().mockResolvedValue([]) },
    };
    await expect(computeSqlLineageCoverage("proj-empty", prisma)).resolves.toBeNull();
  });
});
