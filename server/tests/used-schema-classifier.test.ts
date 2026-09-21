/**
 * Unit tests for the used/unreferenced/uncertain classifier — Epic #292 (#297).
 *
 * The classifier consumes the #296 reconciler's {@link ReconciledObject}s and
 * derives a {@link UsageClass} per object:
 *   - `used`         — at least one inbound edge that is NOT a not-found/dynamic.
 *   - `unreferenced` — exists in schema, no edges at all.
 *   - `uncertain`    — table/column-not-found or dynamic/unresolved edge.
 *
 * `uncertain` MUST carry a reason code and MUST NEVER be safe-to-review.
 * `unreferenced` MAY be safe-to-review (candidate only — never auto-drop).
 *
 * Pure classification logic — no DB. Persistence is exercised separately via the
 * Prisma-mock test below.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReconciledObject } from "@metis/shared";
import {
  classifyReconciledObjects,
  classifyObject,
} from "../src/lib/impact-analysis/used-schema-classifier.js";

function obj(over: Partial<ReconciledObject>): ReconciledObject {
  return {
    kind: "table",
    tableName: "public.t",
    columnName: null,
    columnType: null,
    existsInSchema: true,
    evidence: [],
    ...over,
  };
}

describe("classifyObject", () => {
  it("classifies an object with a matched inbound edge as used", () => {
    const c = classifyObject(
      obj({
        evidence: [
          {
            edgeKind: "reads",
            source: "mybatis",
            fromQualifiedName: "M.x",
            reconciliation: "matched",
          },
        ],
      }),
    );
    expect(c.usageClass).toBe("used");
    expect(c.uncertainReason).toBeNull();
    expect(c.safeToReview).toBe(false);
  });

  it("treats a null-reconciliation live-db edge as used (no mismatch flagged)", () => {
    const c = classifyObject(
      obj({
        evidence: [
          { edgeKind: "writes", source: "live-db", fromQualifiedName: null, reconciliation: null },
        ],
      }),
    );
    expect(c.usageClass).toBe("used");
  });

  it("classifies a schema object with no edges as unreferenced + safe-to-review", () => {
    const c = classifyObject(obj({ evidence: [] }));
    expect(c.usageClass).toBe("unreferenced");
    expect(c.uncertainReason).toBeNull();
    expect(c.safeToReview).toBe(true);
  });

  it("classifies a table-not-found edge as uncertain with reason, never safe", () => {
    const c = classifyObject(
      obj({
        existsInSchema: false,
        evidence: [
          {
            edgeKind: "persists-to",
            source: "ddl-file",
            fromQualifiedName: "D.s",
            reconciliation: "table-not-found",
          },
        ],
      }),
    );
    expect(c.usageClass).toBe("uncertain");
    expect(c.uncertainReason).toBe("table-not-found");
    expect(c.safeToReview).toBe(false);
  });

  it("classifies a column-not-found edge as uncertain (column-not-found)", () => {
    const c = classifyObject(
      obj({
        kind: "column",
        columnName: "missing",
        existsInSchema: false,
        evidence: [
          {
            edgeKind: "reads",
            source: "orm",
            fromQualifiedName: "O.r",
            reconciliation: "column-not-found",
          },
        ],
      }),
    );
    expect(c.usageClass).toBe("uncertain");
    expect(c.uncertainReason).toBe("column-not-found");
  });

  it("classifies an edge with no reconciliation against a non-existent object as dynamic uncertain", () => {
    // existsInSchema=false but edge reconciliation is null → statically unresolved.
    const c = classifyObject(
      obj({
        existsInSchema: false,
        evidence: [
          { edgeKind: "reads", source: "mybatis", fromQualifiedName: "M.x", reconciliation: null },
        ],
      }),
    );
    expect(c.usageClass).toBe("uncertain");
    expect(c.uncertainReason).toBe("dynamic-reference");
  });

  it("prefers used when an object has BOTH a matched edge and a not-found edge", () => {
    // A live object reached by a good edge plus a stray not-found edge is still
    // used — the good evidence wins; we never downgrade a used object.
    const c = classifyObject(
      obj({
        evidence: [
          {
            edgeKind: "reads",
            source: "mybatis",
            fromQualifiedName: "A",
            reconciliation: "matched",
          },
          {
            edgeKind: "reads",
            source: "orm",
            fromQualifiedName: "B",
            reconciliation: "column-not-found",
          },
        ],
      }),
    );
    expect(c.usageClass).toBe("used");
  });
});

describe("classifyReconciledObjects", () => {
  it("classifies a batch and preserves order + evidence", () => {
    const out = classifyReconciledObjects([
      obj({ tableName: "public.a", evidence: [] }),
      obj({
        tableName: "public.b",
        evidence: [
          {
            edgeKind: "reads",
            source: "mybatis",
            fromQualifiedName: "x",
            reconciliation: "matched",
          },
        ],
      }),
    ]);
    expect(out.map((o) => o.usageClass)).toEqual(["unreferenced", "used"]);
    expect(out[1].evidence).toHaveLength(1);
  });

  it("never marks any uncertain object safe-to-review (drop-safety invariant)", () => {
    const out = classifyReconciledObjects([
      obj({
        existsInSchema: false,
        evidence: [
          {
            edgeKind: "reads",
            source: "orm",
            fromQualifiedName: "x",
            reconciliation: "table-not-found",
          },
        ],
      }),
    ]);
    expect(out.every((o) => (o.usageClass === "uncertain" ? o.safeToReview === false : true))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Persistence (Prisma fully mocked — never touches a real DB; see #289 lesson).
// ---------------------------------------------------------------------------

describe("persistUsageClassification", () => {
  it("deletes prior rows then bulk-creates the new classification within a txn", async () => {
    const deleteMany = vi.fn(async () => ({ count: 3 }));
    const createMany = vi.fn(async () => ({ count: 2 }));
    const tx = { schemaUsageClassification: { deleteMany, createMany } };
    const prisma = {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const { persistUsageClassification } =
      await import("../src/lib/impact-analysis/used-schema-classifier.js");

    const written = await persistUsageClassification(
      prisma as never,
      "proj_1",
      classifyReconciledObjects([
        obj({ tableName: "public.a", evidence: [] }),
        obj({
          tableName: "public.b",
          evidence: [
            {
              edgeKind: "reads",
              source: "mybatis",
              fromQualifiedName: "x",
              reconciliation: "matched",
            },
          ],
        }),
      ]),
    );

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(deleteMany).toHaveBeenCalledWith({ where: { projectId: "proj_1" } });
    expect(createMany).toHaveBeenCalledOnce();
    const arg = createMany.mock.calls[0][0] as { data: Record<string, unknown>[] };
    expect(arg.data).toHaveLength(2);
    // Evidence is serialized to a JSON string; overriddenClass seam is null.
    expect(typeof arg.data[1].evidence).toBe("string");
    expect(arg.data[1].overriddenClass).toBeNull();
    expect(arg.data[1].usageClass).toBe("used");
    expect(written).toBe(2);
  });

  it("scopes deletion to the project (tenant isolation)", async () => {
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const createMany = vi.fn(async () => ({ count: 0 }));
    const tx = { schemaUsageClassification: { deleteMany, createMany } };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const { persistUsageClassification } =
      await import("../src/lib/impact-analysis/used-schema-classifier.js");
    await persistUsageClassification(prisma as never, "proj_xyz", []);
    expect(deleteMany).toHaveBeenCalledWith({ where: { projectId: "proj_xyz" } });
    // Empty classification → no createMany call (nothing to insert).
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe("readUsageClassification", () => {
  it("maps persisted rows to views and parses evidence JSON, scoped to project", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "c1",
        projectId: "proj_1",
        kind: "table",
        tableName: "public.b",
        columnName: null,
        columnType: null,
        usageClass: "used",
        uncertainReason: null,
        evidence: JSON.stringify([
          {
            edgeKind: "reads",
            source: "mybatis",
            fromQualifiedName: "x",
            reconciliation: "matched",
          },
        ]),
        overriddenClass: null,
        computedAt: new Date("2026-06-18T00:00:00Z"),
      },
    ]);
    const prisma = { schemaUsageClassification: { findMany } };
    const { readUsageClassification } =
      await import("../src/lib/impact-analysis/used-schema-classifier.js");
    const views = await readUsageClassification(prisma as never, "proj_1");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "proj_1" } }),
    );
    expect(views).toHaveLength(1);
    expect(views[0].evidence[0].edgeKind).toBe("reads");
    expect(views[0].computedAt).toBe("2026-06-18T00:00:00.000Z");
    expect(views[0].usageClass).toBe("used");
  });

  it("tolerates malformed evidence JSON by returning an empty evidence list", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "c2",
        projectId: "proj_1",
        kind: "table",
        tableName: "public.c",
        columnName: null,
        columnType: null,
        usageClass: "unreferenced",
        uncertainReason: null,
        evidence: "{not json",
        overriddenClass: null,
        computedAt: new Date("2026-06-18T00:00:00Z"),
      },
    ]);
    const prisma = { schemaUsageClassification: { findMany } };
    const { readUsageClassification } =
      await import("../src/lib/impact-analysis/used-schema-classifier.js");
    const views = await readUsageClassification(prisma as never, "proj_1");
    expect(views[0].evidence).toEqual([]);
  });
});
