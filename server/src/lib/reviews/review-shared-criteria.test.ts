/**
 * Issue #1203 — a review's requirement items carry the record of criteria a
 * synthesis item wrote for several requirements, read from the analysis.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    analysisId: string;
    projectId: string;
    title: string;
    deletedAt?: Date | null;
  }>,
  analyses: [] as Array<{ id: string; projectId: string; metadata: string | null }>,
  fail: false,
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    requirement: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { id: { in: string[] }; projectId: string; deletedAt?: null };
        }) => {
          if (db.fail) throw new Error("db down");
          return db.rows.filter(
            (r) =>
              where.id.in.includes(r.id) &&
              r.projectId === where.projectId &&
              (where.deletedAt !== null || !r.deletedAt),
          );
        },
      ),
    },
    analysis: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; projectId: string } }) =>
        db.analyses.filter((a) => where.id.in.includes(a.id) && a.projectId === where.projectId),
      ),
    },
  },
}));

const { attachSharedCriteria } = await import("./review-shared-criteria.js");
const { prisma } = await import("../prisma.js");

const GROUP = ["Logging out ends every session."];
const entry = (requirementId: string, sibling: { id: string | null; title: string }) => ({
  requirementId,
  structuredId: `S-${requirementId}`,
  sharedWith: [
    { structuredId: "S-x", title: sibling.title, requirementId: sibling.id, approved: true },
  ],
  sharedCriteria: GROUP,
  promotedCriteria: GROUP,
});
const metadata = (shared: unknown[]) =>
  JSON.stringify({ promotionMatching: { ambiguous: [], shared, updatedAt: "x" } });

beforeEach(() => {
  vi.clearAllMocks();
  db.fail = false;
  db.rows = [
    { id: "rq_1", analysisId: "an_1", projectId: "p1", title: "Flush on logout" },
    { id: "rq_2", analysisId: "an_1", projectId: "p1", title: "Flush on reset (renamed)" },
    { id: "rq_other", analysisId: "an_other", projectId: "p2", title: "Elsewhere" },
  ];
  db.analyses = [
    {
      id: "an_1",
      projectId: "p1",
      metadata: metadata([entry("rq_1", { id: "rq_2", title: "Flush on reset" })]),
    },
    {
      id: "an_other",
      projectId: "p2",
      metadata: metadata([entry("rq_other", { id: null, title: "x" })]),
    },
  ];
});

describe("attachSharedCriteria", () => {
  it("attaches the record with the sibling's current title, and null to items without one", async () => {
    const out = (await attachSharedCriteria({
      projectId: "p1",
      items: [{ requirementId: "rq_1" }, { requirementId: "rq_2" }, { requirementId: null }],
    })) as { items: Array<{ sharedCriteria?: unknown }> };

    expect(out.items[0]?.sharedCriteria).toEqual({
      projectId: "p1",
      analysisId: "an_1",
      record: entry("rq_1", { id: "rq_2", title: "Flush on reset (renamed)" }),
    });
    expect(out.items[1]?.sharedCriteria).toBeNull();
    expect(out.items[2]?.sharedCriteria).toBeNull();
  });

  it("never reads another project's requirement or analysis", async () => {
    const out = (await attachSharedCriteria({
      projectId: "p1",
      items: [{ requirementId: "rq_other" }],
    })) as { items: Array<{ sharedCriteria?: unknown }> };

    expect(out.items[0]?.sharedCriteria).toBeNull();
  });

  it("keeps the recorded title for a sibling with no row", async () => {
    db.analyses[0]!.metadata = metadata([entry("rq_1", { id: null, title: "Not approved" })]);
    const out = (await attachSharedCriteria({
      projectId: "p1",
      items: [{ requirementId: "rq_1" }],
    })) as { items: Array<{ sharedCriteria?: { record: { sharedWith: unknown[] } } }> };

    expect(out.items[0]?.sharedCriteria?.record.sharedWith).toEqual([
      { structuredId: "S-x", title: "Not approved", requirementId: null, approved: true },
    ]);
    // No sibling row to look up: only the one query for the items' rows.
    expect(vi.mocked(prisma.requirement.findMany)).toHaveBeenCalledTimes(1);
  });

  // #1203 review — a soft-deleted sibling has no card: it keeps its promoted
  // title and loses its row id, so the review card names it without a link.
  it("drops the row id of a sibling whose row is deleted, keeping its promoted title", async () => {
    db.rows[1]!.deletedAt = new Date();
    const out = (await attachSharedCriteria({
      projectId: "p1",
      items: [{ requirementId: "rq_1" }],
    })) as { items: Array<{ sharedCriteria?: { record: { sharedWith: unknown[] } } }> };

    expect(out.items[0]?.sharedCriteria?.record.sharedWith).toEqual([
      { structuredId: "S-x", title: "Flush on reset", requirementId: null, approved: true },
    ]);
  });

  it("issues no query for a review of documents only", async () => {
    const review = { projectId: "p1", items: [{ requirementId: null }] };
    expect(await attachSharedCriteria(review)).toBe(review);
    expect(vi.mocked(prisma.requirement.findMany)).not.toHaveBeenCalled();
  });

  it("leaves the review undecorated when the read fails", async () => {
    db.fail = true;
    const review = { projectId: "p1", items: [{ requirementId: "rq_1" }] };
    expect(await attachSharedCriteria(review)).toBe(review);
  });
});
