/**
 * Epic #394 P2 (#403) — webhook-dedup unit tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  deliveryId: string;
  eventType: string;
  receivedAt: Date;
  runId: string | null;
}
const rows = new Map<string, Row>();

vi.mock("../../prisma.js", () => ({
  prisma: {
    prReviewWebhookDelivery: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: vi.fn(async ({ data }: any) => {
        if (rows.has(data.deliveryId)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const err: any = new Error(
            "UNIQUE constraint failed: pr_review_webhook_deliveries.deliveryId",
          );
          err.code = "P2002";
          throw err;
        }
        const row: Row = {
          id: `dl_${rows.size + 1}`,
          deliveryId: data.deliveryId,
          eventType: data.eventType,
          receivedAt: new Date(),
          runId: data.runId ?? null,
        };
        rows.set(data.deliveryId, row);
        return row;
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const r of rows.values()) {
          if (r.deliveryId === where.deliveryId) {
            r.runId = data.runId;
            count += 1;
          }
        }
        return { count };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deleteMany: vi.fn(async ({ where }: any) => {
        const cutoff = where.receivedAt.lt as Date;
        let count = 0;
        for (const [k, r] of rows.entries()) {
          if (r.receivedAt < cutoff) {
            rows.delete(k);
            count += 1;
          }
        }
        return { count };
      }),
    },
  },
}));

import { recordDelivery, attachRunId, purgeOldDeliveries } from "./webhook-dedup.js";

beforeEach(() => {
  rows.clear();
});

describe("recordDelivery", () => {
  it("inserts a fresh delivery and returns duplicate=false", async () => {
    const out = await recordDelivery({ deliveryId: "abc-123", eventType: "pull_request" });
    expect(out.duplicate).toBe(false);
    expect(out.deliveryId).toBe("abc-123");
    expect(rows.size).toBe(1);
  });

  it("returns duplicate=true on a second insert with the same id", async () => {
    await recordDelivery({ deliveryId: "abc-123", eventType: "pull_request" });
    const out = await recordDelivery({ deliveryId: "abc-123", eventType: "pull_request" });
    expect(out.duplicate).toBe(true);
  });

  it("treats whitespace deliveryId as non-deduplicatable (no insert)", async () => {
    const out = await recordDelivery({ deliveryId: "   ", eventType: "pull_request" });
    expect(out.duplicate).toBe(false);
    expect(out.deliveryId).toBe("");
    expect(rows.size).toBe(0);
  });

  it("rethrows non-unique-constraint errors", async () => {
    const { prisma } = await import("../../prisma.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).prReviewWebhookDelivery.create.mockImplementationOnce(async () => {
      throw new Error("DB exploded");
    });
    await expect(recordDelivery({ deliveryId: "x", eventType: "pull_request" })).rejects.toThrow(
      /DB exploded/,
    );
  });

  it("detects 'duplicate key' message style as a unique violation", async () => {
    const { prisma } = await import("../../prisma.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).prReviewWebhookDelivery.create.mockImplementationOnce(async () => {
      throw new Error("duplicate key value violates unique constraint");
    });
    const out = await recordDelivery({ deliveryId: "y", eventType: "pull_request" });
    expect(out.duplicate).toBe(true);
  });

  it("treats undefined error as non-unique and rethrows", async () => {
    const { prisma } = await import("../../prisma.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).prReviewWebhookDelivery.create.mockImplementationOnce(async () => {
      throw 42;
    });
    await expect(
      recordDelivery({ deliveryId: "z", eventType: "pull_request" }),
    ).rejects.toBeDefined();
  });
});

describe("attachRunId", () => {
  it("updates the runId for an existing delivery", async () => {
    await recordDelivery({ deliveryId: "del-1", eventType: "pull_request" });
    await attachRunId("del-1", "run_42");
    expect(rows.get("del-1")?.runId).toBe("run_42");
  });

  it("is a no-op when delivery id is empty", async () => {
    await attachRunId("", "run_1");
    expect(rows.size).toBe(0);
  });
});

describe("purgeOldDeliveries", () => {
  it("removes rows older than the retention window", async () => {
    await recordDelivery({ deliveryId: "old", eventType: "pull_request" });
    rows.get("old")!.receivedAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await recordDelivery({ deliveryId: "fresh", eventType: "pull_request" });
    const purged = await purgeOldDeliveries();
    expect(purged).toBe(1);
    expect(rows.has("old")).toBe(false);
    expect(rows.has("fresh")).toBe(true);
  });

  it("respects custom retention", async () => {
    await recordDelivery({ deliveryId: "x", eventType: "pull_request" });
    rows.get("x")!.receivedAt = new Date(Date.now() - 5_000);
    const purged = await purgeOldDeliveries(1_000);
    expect(purged).toBe(1);
  });
});
