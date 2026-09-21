/**
 * Tests for the affected-table relevance feedback service — Issue #966 (Epic
 * #960). Pure unit tests with an in-memory Prisma double (no real DB). Covers
 * target-item resolution (tenant scoping), upsert idempotency, and delete
 * scoping (IDOR safety — a caller may only remove their own mark).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteTableFeedback,
  findFeedbackTargetItem,
  upsertTableFeedback,
} from "../src/lib/impact-analysis/table-feedback.js";

interface ItemRow {
  id: string;
  impactAnalysisId: string;
  projectId: string;
}

interface FeedbackRow {
  id: string;
  impactAnalysisId: string;
  impactItemId: string;
  tableName: string;
  columnName: string | null;
  verdict: string;
  userId: string;
  userDisplayName: string;
  createdAt: Date;
  updatedAt: Date;
}

function makeFakePrisma() {
  const items: ItemRow[] = [
    { id: "item-1", impactAnalysisId: "ia-1", projectId: "project-001" },
    { id: "item-2", impactAnalysisId: "ia-2", projectId: "project-002" },
  ];
  const rows: FeedbackRow[] = [];
  let seq = 0;
  return {
    rows,
    impactItem: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async ({ where }: any) => items.find((i) => i.id === where.id) ?? null,
    },
    impactTableFeedback: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async ({ where }: any) =>
        rows.find(
          (r) =>
            r.impactItemId === where.impactItemId &&
            r.tableName === where.tableName &&
            r.columnName === (where.columnName ?? null) &&
            r.userId === where.userId,
        ) ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async ({ data }: any) => {
        seq += 1;
        const row: FeedbackRow = {
          id: `fb_${seq}`,
          impactAnalysisId: data.impactAnalysisId,
          impactItemId: data.impactItemId,
          tableName: data.tableName,
          columnName: data.columnName ?? null,
          verdict: data.verdict,
          userId: data.userId,
          userDisplayName: data.userDisplayName,
          createdAt: new Date("2026-07-20T00:00:00Z"),
          updatedAt: new Date("2026-07-20T00:00:00Z"),
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
      deleteMany: async ({ where }: any) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i];
          if (
            r.id === where.id &&
            r.impactItemId === where.impactItemId &&
            r.impactAnalysisId === where.impactAnalysisId &&
            r.userId === where.userId
          ) {
            rows.splice(i, 1);
          }
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

describe("findFeedbackTargetItem", () => {
  it("resolves an item scoped to its own analysis", async () => {
    const item = await findFeedbackTargetItem(prisma, "ia-1", "item-1");
    expect(item).toEqual({ id: "item-1", impactAnalysisId: "ia-1", projectId: "project-001" });
  });

  it("returns null for an unknown item id", async () => {
    expect(await findFeedbackTargetItem(prisma, "ia-1", "item-ghost")).toBeNull();
  });

  it("returns null when the item belongs to a DIFFERENT analysis (no cross-tenant leak)", async () => {
    expect(await findFeedbackTargetItem(prisma, "ia-1", "item-2")).toBeNull();
  });
});

describe("upsertTableFeedback", () => {
  it("creates a new table-level feedback row", async () => {
    const view = await upsertTableFeedback(
      prisma,
      "ia-1",
      "item-1",
      { tableName: "crm.customers", verdict: "relevant" },
      { id: "user-1", displayName: "alice" },
    );
    expect(view).toMatchObject({
      impactItemId: "item-1",
      tableName: "crm.customers",
      columnName: null,
      verdict: "relevant",
      userId: "user-1",
      userDisplayName: "alice",
    });
    expect(prisma.rows).toHaveLength(1);
  });

  it("creates a column-level feedback row when columnName is set", async () => {
    const view = await upsertTableFeedback(
      prisma,
      "ia-1",
      "item-1",
      { tableName: "crm.customers", columnName: "email", verdict: "not-relevant" },
      { id: "user-1", displayName: "alice" },
    );
    expect(view.columnName).toBe("email");
    expect(view.verdict).toBe("not-relevant");
  });

  it("is idempotent per (item, table, column, user): re-marking UPDATES not duplicates", async () => {
    await upsertTableFeedback(
      prisma,
      "ia-1",
      "item-1",
      { tableName: "crm.customers", verdict: "relevant" },
      { id: "user-1", displayName: "alice" },
    );
    const second = await upsertTableFeedback(
      prisma,
      "ia-1",
      "item-1",
      { tableName: "crm.customers", verdict: "not-relevant" },
      { id: "user-1", displayName: "alice" },
    );
    expect(prisma.rows).toHaveLength(1);
    expect(second.verdict).toBe("not-relevant");
  });

  it("lets two different users mark the same table independently", async () => {
    await upsertTableFeedback(
      prisma,
      "ia-1",
      "item-1",
      { tableName: "crm.customers", verdict: "relevant" },
      { id: "user-1", displayName: "alice" },
    );
    await upsertTableFeedback(
      prisma,
      "ia-1",
      "item-1",
      { tableName: "crm.customers", verdict: "not-relevant" },
      { id: "user-2", displayName: "bob" },
    );
    expect(prisma.rows).toHaveLength(2);
  });

  it("treats a null columnName distinctly from a set columnName for the same table", async () => {
    await upsertTableFeedback(
      prisma,
      "ia-1",
      "item-1",
      { tableName: "crm.customers", verdict: "relevant" },
      { id: "user-1", displayName: "alice" },
    );
    await upsertTableFeedback(
      prisma,
      "ia-1",
      "item-1",
      { tableName: "crm.customers", columnName: "email", verdict: "relevant" },
      { id: "user-1", displayName: "alice" },
    );
    expect(prisma.rows).toHaveLength(2);
  });
});

describe("deleteTableFeedback", () => {
  it("removes a feedback row owned by the caller", async () => {
    const view = await upsertTableFeedback(
      prisma,
      "ia-1",
      "item-1",
      { tableName: "crm.customers", verdict: "relevant" },
      { id: "user-1", displayName: "alice" },
    );
    const removed = await deleteTableFeedback(prisma, "ia-1", "item-1", view.id, "user-1");
    expect(removed).toBe(true);
    expect(prisma.rows).toHaveLength(0);
  });

  it("returns false and does not remove another user's feedback row (IDOR-safe)", async () => {
    const view = await upsertTableFeedback(
      prisma,
      "ia-1",
      "item-1",
      { tableName: "crm.customers", verdict: "relevant" },
      { id: "user-1", displayName: "alice" },
    );
    const removed = await deleteTableFeedback(prisma, "ia-1", "item-1", view.id, "user-2");
    expect(removed).toBe(false);
    expect(prisma.rows).toHaveLength(1);
  });

  it("returns false for an unknown feedback id", async () => {
    const removed = await deleteTableFeedback(prisma, "ia-1", "item-1", "fb_ghost", "user-1");
    expect(removed).toBe(false);
  });
});
