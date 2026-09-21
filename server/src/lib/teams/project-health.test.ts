/**
 * Epic #63 (#578) — project-health summarizer tests.
 *
 * The summarizer is read-only and Prisma is injected, so it is exercised with a
 * tiny stub: no live DB, deterministic counts.
 */
import { describe, expect, it, vi } from "vitest";

import { summarizeProjectHealth, type ProjectHealthPrisma } from "./project-health.js";

const PROJECT = "project-1";

function makeDb(
  over: {
    project?: { id: string; name: string; status: string } | null;
    requirementCount?: number;
    draftCounts?: { draft: number; approved: number; published: number };
    latestAnalysis?: { status: string } | null;
    latestBatch?: { status: string } | null;
  } = {},
): ProjectHealthPrisma {
  const draftCounts = over.draftCounts ?? { draft: 0, approved: 0, published: 0 };
  return {
    project: {
      findFirst: vi.fn(async () =>
        over.project === undefined
          ? { id: PROJECT, name: "Apollo", status: "active" }
          : over.project,
      ),
    },
    requirement: {
      count: vi.fn(async () => over.requirementCount ?? 0),
    },
    issueDraft: {
      count: vi.fn(async (args: { where: { status: string } }) => {
        const s = args.where.status as keyof typeof draftCounts;
        return draftCounts[s] ?? 0;
      }),
    },
    analysis: {
      findFirst: vi.fn(async () =>
        over.latestAnalysis === undefined ? { status: "completed" } : over.latestAnalysis,
      ),
    },
    publishBatch: {
      findFirst: vi.fn(async () =>
        over.latestBatch === undefined ? { status: "pending" } : over.latestBatch,
      ),
    },
  } as unknown as ProjectHealthPrisma;
}

describe("summarizeProjectHealth", () => {
  it("returns a compact snapshot with indexed counts + latest run statuses", async () => {
    const db = makeDb({
      requirementCount: 42,
      draftCounts: { draft: 3, approved: 5, published: 11 },
      latestAnalysis: { status: "completed" },
      latestBatch: { status: "running" },
    });

    const summary = await summarizeProjectHealth(PROJECT, db);

    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({
      projectId: PROJECT,
      name: "Apollo",
      status: "active",
      requirementCount: 42,
      drafts: { pending: 3, approved: 5, published: 11 },
      latestAnalysisStatus: "completed",
      latestPublishStatus: "running",
    });
  });

  it("returns null for a missing / soft-deleted project (no leak)", async () => {
    const db = makeDb({ project: null });
    expect(await summarizeProjectHealth(PROJECT, db)).toBeNull();
    // Never queries counts for a non-existent project.
    expect(db.requirement.count as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("reports null latest statuses when no analysis / batch has run", async () => {
    const db = makeDb({ latestAnalysis: null, latestBatch: null });
    const summary = await summarizeProjectHealth(PROJECT, db);
    expect(summary?.latestAnalysisStatus).toBeNull();
    expect(summary?.latestPublishStatus).toBeNull();
  });

  it("scopes the requirement count to non-deleted rows of the project", async () => {
    const db = makeDb({ requirementCount: 7 });
    await summarizeProjectHealth(PROJECT, db);
    const call = (db.requirement.count as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where).toMatchObject({ projectId: PROJECT, deletedAt: null });
  });
});
