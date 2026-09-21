/**
 * Draft generator — Phase 9 (#67).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Draft {
  id: string;
  projectId: string;
  requirementId: string | null;
  parentDraftId: string | null;
  draftType: string;
  title: string;
  body: string;
  labels: string;
  assignees: string;
  storyPoints: number;
  status: string;
  dedupHash: string | null;
  metadata: string | null;
  deletedAt: Date | null;
}

const drafts = new Map<string, Draft>();
let nextId = 0;

const fakeProject = { id: "proj_1", name: "Apollo", deletedAt: null as Date | null };
const fakeAnalysis = {
  id: "analysis_1",
  projectId: "proj_1",
  deletedAt: null as Date | null,
};

const requirements = [
  {
    id: "req_1",
    analysisId: "analysis_1",
    title: "Login form",
    body: "Given a visitor\nWhen they submit credentials\nThen a session is created",
    type: "feature",
    priority: "critical",
    labels: '["auth"]',
    storyPoints: null,
    deletedAt: null as Date | null,
  },
  {
    id: "req_2",
    analysisId: "analysis_1",
    title: "Logout button",
    body: "Should clear the session",
    type: "task",
    priority: "low",
    labels: "[]",
    storyPoints: 1,
    deletedAt: null as Date | null,
  },
];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === fakeProject.id ? fakeProject : null,
      ),
    },
    analysis: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === fakeAnalysis.id ? fakeAnalysis : null,
      ),
    },
    requirement: {
      findMany: vi.fn(async () => requirements),
    },
    issueDraft: {
      findFirst: vi.fn(async ({ where }: { where: { dedupHash?: string } }) => {
        if (!where.dedupHash) return null;
        for (const d of drafts.values()) {
          if (d.dedupHash === where.dedupHash && !d.deletedAt) return d;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Partial<Draft> }) => {
        nextId += 1;
        const row: Draft = {
          id: `draft_${nextId}`,
          projectId: fakeProject.id,
          requirementId: null,
          parentDraftId: null,
          draftType: "feature",
          title: "",
          body: "",
          labels: "[]",
          assignees: "[]",
          storyPoints: 1,
          status: "draft",
          dedupHash: null,
          metadata: null,
          deletedAt: null,
          ...(data as Draft),
        };
        drafts.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Draft> }) => {
        const existing = drafts.get(where.id);
        if (!existing) throw new Error("not found");
        const next = { ...existing, ...data };
        drafts.set(where.id, next);
        return next;
      }),
    },
  },
}));

import { estimateStoryPoints, generateDrafts } from "../src/lib/publishing/draft-generator.js";
import { PublishError } from "../src/lib/publishing/types.js";

beforeEach(() => {
  drafts.clear();
  nextId = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("estimateStoryPoints", () => {
  it("snaps to Fibonacci points", () => {
    expect([1, 2, 3, 5, 8, 13]).toContain(
      estimateStoryPoints({ priority: "critical", evidenceCount: 0 }),
    );
    expect(estimateStoryPoints({ priority: "low", evidenceCount: 0 })).toBe(2);
    expect(estimateStoryPoints({ priority: "critical", evidenceCount: 99 })).toBe(8);
  });
});

describe("generateDrafts", () => {
  it("creates an epic + per-requirement features and is idempotent", async () => {
    const first = await generateDrafts({
      projectId: "proj_1",
      analysisId: "analysis_1",
      targetOwner: "acme",
      targetRepo: "metis",
    });
    expect(first.epics).toBe(1);
    expect(first.features).toBe(2);
    expect(first.upserted).toBe(3);
    expect(first.refreshed).toBe(0);
    expect(drafts.size).toBe(3);

    const second = await generateDrafts({
      projectId: "proj_1",
      analysisId: "analysis_1",
      targetOwner: "acme",
      targetRepo: "metis",
    });
    expect(second.upserted).toBe(0);
    expect(second.refreshed).toBe(3);
    // Total drafts unchanged — no duplicates.
    expect(drafts.size).toBe(3);
  });

  it("rejects when project missing", async () => {
    await expect(
      generateDrafts({
        projectId: "nope",
        analysisId: "analysis_1",
        targetOwner: "acme",
        targetRepo: "metis",
      }),
    ).rejects.toBeInstanceOf(PublishError);
  });

  it("rejects when analysis has no requirements", async () => {
    requirements.length = 0;
    try {
      await expect(
        generateDrafts({
          projectId: "proj_1",
          analysisId: "analysis_1",
          targetOwner: "acme",
          targetRepo: "metis",
        }),
      ).rejects.toMatchObject({ code: "NO_REQUIREMENTS" });
    } finally {
      requirements.push(
        {
          id: "req_1",
          analysisId: "analysis_1",
          title: "Login form",
          body: "Given a visitor\nWhen they submit credentials\nThen a session is created",
          type: "feature",
          priority: "critical",
          labels: '["auth"]',
          storyPoints: null,
          deletedAt: null,
        },
        {
          id: "req_2",
          analysisId: "analysis_1",
          title: "Logout button",
          body: "Should clear the session",
          type: "task",
          priority: "low",
          labels: "[]",
          storyPoints: 1,
          deletedAt: null,
        },
      );
    }
  });

  it("renders a Mermaid diagram and traceability footer in the epic", async () => {
    await generateDrafts({
      projectId: "proj_1",
      analysisId: "analysis_1",
      targetOwner: "acme",
      targetRepo: "metis",
    });
    const epic = [...drafts.values()].find((d) => d.draftType === "epic");
    expect(epic).toBeDefined();
    expect(epic!.body).toContain("```mermaid");
    expect(epic!.body).toContain("Generated by METIS");
  });
});
