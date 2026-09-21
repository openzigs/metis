/**
 * Tests for the manual schema-usage override service — Epic #294 (#304).
 *
 * Pure unit tests with an in-memory Prisma double (no real DB). Covers upsert
 * idempotency, list/delete project-scoping, and the `applyOverrides` precedence
 * merge (manual wins; synthetic rows for assertions on unseen objects).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ManualUsageOverrideView, SchemaUsageClassificationView } from "@metis/shared";
import {
  applyOverrides,
  deleteManualOverride,
  listManualOverrides,
  upsertManualOverride,
} from "../src/lib/impact-analysis/schema-usage-override.js";

interface Row {
  id: string;
  projectId: string;
  kind: string;
  tableName: string;
  columnName: string | null;
  usageClass: string;
  access: string;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakePrisma() {
  const rows: Row[] = [];
  let seq = 0;
  return {
    rows,
    schemaUsageOverride: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async ({ where }: any) =>
        rows.find(
          (r) =>
            r.projectId === where.projectId &&
            r.tableName === where.tableName &&
            r.columnName === (where.columnName ?? null) &&
            r.access === where.access,
        ) ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async ({ data }: any) => {
        seq += 1;
        const row: Row = {
          id: `ov_${seq}`,
          projectId: data.projectId,
          kind: data.kind,
          tableName: data.tableName,
          columnName: data.columnName ?? null,
          usageClass: data.usageClass,
          access: data.access,
          note: data.note ?? null,
          createdBy: data.createdBy ?? null,
          createdAt: new Date("2026-06-18T00:00:00Z"),
          updatedAt: new Date("2026-06-18T00:00:00Z"),
        };
        rows.push(row);
        return row;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) => rows.filter((r) => r.projectId === where.projectId),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deleteMany: async ({ where }: any) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].id === where.id && rows[i].projectId === where.projectId) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      },
    },
  };
}

let prisma: ReturnType<typeof makeFakePrisma>;

beforeEach(() => {
  prisma = makeFakePrisma();
});

describe("upsertManualOverride", () => {
  it("creates a new override row", async () => {
    const view = await upsertManualOverride(
      prisma,
      "proj1",
      {
        kind: "column",
        tableName: "Orders",
        columnName: "Total",
        usageClass: "used",
        access: "reads",
      },
      "user1",
    );
    expect(view.tableName).toBe("orders"); // normalized
    expect(view.columnName).toBe("total");
    expect(view.usageClass).toBe("used");
    expect(view.createdBy).toBe("user1");
    expect(prisma.rows).toHaveLength(1);
  });

  it("updates in place when re-asserting the same target (idempotent)", async () => {
    await upsertManualOverride(
      prisma,
      "proj1",
      { kind: "table", tableName: "orders", usageClass: "used", access: "reads" },
      "user1",
    );
    const second = await upsertManualOverride(
      prisma,
      "proj1",
      {
        kind: "table",
        tableName: "orders",
        usageClass: "unreferenced",
        access: "reads",
        note: "fixed",
      },
      "user2",
    );
    expect(prisma.rows).toHaveLength(1);
    expect(second.usageClass).toBe("unreferenced");
    expect(second.note).toBe("fixed");
  });

  it("treats a table override (null column) and a column override as distinct", async () => {
    await upsertManualOverride(
      prisma,
      "p",
      { kind: "table", tableName: "t", usageClass: "used", access: "reads" },
      null,
    );
    await upsertManualOverride(
      prisma,
      "p",
      { kind: "column", tableName: "t", columnName: "c", usageClass: "used", access: "reads" },
      null,
    );
    expect(prisma.rows).toHaveLength(2);
  });

  it("distinguishes overrides by access kind", async () => {
    await upsertManualOverride(
      prisma,
      "p",
      { kind: "table", tableName: "t", usageClass: "used", access: "reads" },
      null,
    );
    await upsertManualOverride(
      prisma,
      "p",
      { kind: "table", tableName: "t", usageClass: "used", access: "writes" },
      null,
    );
    expect(prisma.rows).toHaveLength(2);
  });
});

describe("listManualOverrides / deleteManualOverride", () => {
  it("lists only the project's rows", async () => {
    await upsertManualOverride(
      prisma,
      "p1",
      { kind: "table", tableName: "a", usageClass: "used", access: "reads" },
      null,
    );
    await upsertManualOverride(
      prisma,
      "p2",
      { kind: "table", tableName: "b", usageClass: "used", access: "reads" },
      null,
    );
    const list = await listManualOverrides(prisma, "p1");
    expect(list).toHaveLength(1);
    expect(list[0].tableName).toBe("a");
  });

  it("deletes only within the project and reports removal", async () => {
    const v = await upsertManualOverride(
      prisma,
      "p1",
      { kind: "table", tableName: "a", usageClass: "used", access: "reads" },
      null,
    );
    // Wrong project → no delete.
    expect(await deleteManualOverride(prisma, "p2", v.id)).toBe(false);
    expect(await deleteManualOverride(prisma, "p1", v.id)).toBe(true);
    expect(prisma.rows).toHaveLength(0);
  });
});

describe("applyOverrides (precedence merge)", () => {
  const baseRow = (
    over: Partial<SchemaUsageClassificationView> = {},
  ): SchemaUsageClassificationView => ({
    id: "c1",
    projectId: "p",
    kind: "table",
    tableName: "orders",
    columnName: null,
    columnType: null,
    usageClass: "uncertain",
    uncertainReason: "dynamic-reference",
    evidence: [],
    overriddenClass: null,
    computedAt: "2026-06-18T00:00:00.000Z",
    ...over,
  });

  const overrideView = (over: Partial<ManualUsageOverrideView> = {}): ManualUsageOverrideView => ({
    id: "o1",
    projectId: "p",
    kind: "table",
    tableName: "orders",
    columnName: null,
    usageClass: "used",
    access: "reads",
    note: null,
    createdBy: "u",
    createdAt: "2026-06-18T00:00:00.000Z",
    ...over,
  });

  it("returns input unchanged when no overrides", () => {
    const rows = [baseRow()];
    expect(applyOverrides(rows, [])).toBe(rows);
  });

  it("manual override wins over a derived class and records the prior class", () => {
    const merged = applyOverrides([baseRow()], [overrideView()]);
    expect(merged[0].usageClass).toBe("used");
    expect(merged[0].overriddenClass).toBe("uncertain"); // prior derived class preserved
  });

  it("appends a synthetic row when the override targets an unseen object", () => {
    const merged = applyOverrides([baseRow()], [overrideView({ tableName: "ghost_table" })]);
    expect(merged).toHaveLength(2);
    const synthetic = merged.find((r) => r.tableName === "ghost_table")!;
    expect(synthetic.usageClass).toBe("used");
    expect(synthetic.id).toContain("override:");
  });

  it("matches override to classification by normalized identity", () => {
    // Derived row uses lowercase; override targets mixed-case the same object.
    const merged = applyOverrides(
      [baseRow({ tableName: "orders" })],
      [overrideView({ tableName: "Orders" })],
    );
    // applyOverrides normalizes both sides, so the existing row is overridden (not appended).
    expect(merged).toHaveLength(1);
    expect(merged[0].usageClass).toBe("used");
  });

  it("is a no-op (marks overriddenClass) when the override matches the derived class", () => {
    // Derived already `used`; override also asserts `used` → no class change, but
    // overriddenClass is set so the UI shows it was human-confirmed.
    const merged = applyOverrides(
      [baseRow({ usageClass: "used", uncertainReason: null })],
      [overrideView({ usageClass: "used" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].usageClass).toBe("used");
    expect(merged[0].overriddenClass).toBe("used");
  });

  it("keeps the first override when two target the same object", () => {
    const merged = applyOverrides(
      [baseRow()],
      [
        overrideView({ id: "a", usageClass: "used" }),
        overrideView({ id: "b", usageClass: "unreferenced" }),
      ],
    );
    expect(merged[0].usageClass).toBe("used"); // first wins
  });
});
