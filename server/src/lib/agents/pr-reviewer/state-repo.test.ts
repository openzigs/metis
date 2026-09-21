/**
 * Epic #394 P2 (#404, #405) — state-repo unit tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: Map<string, Record<string, unknown>> = new Map();

function key(p: {
  projectId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
}): string {
  return `${p.projectId}|${p.repoOwner}|${p.repoName}|${p.prNumber}`;
}

vi.mock("../../prisma.js", () => ({
  prisma: {
    prReviewState: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: vi.fn(async ({ where }: any) => {
        const k = where.projectId_repoOwner_repoName_prNumber;
        return rows.get(key(k)) ?? null;
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const k = where.projectId_repoOwner_repoName_prNumber;
        const existing = rows.get(key(k));
        const now = new Date();
        if (existing) {
          const updated = { ...existing, ...update, updatedAt: now };
          rows.set(key(k), updated);
          return updated;
        }
        const inserted = {
          id: `prs_${rows.size + 1}`,
          createdAt: now,
          updatedAt: now,
          ...create,
        };
        rows.set(key(k), inserted);
        return inserted;
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: vi.fn(async ({ where, take, skip }: any) => {
        const all = [...rows.values()].filter((r) => r.projectId === where.projectId);
        all.sort((a, b) => (b.updatedAt as Date).getTime() - (a.updatedAt as Date).getTime());
        return all.slice(skip ?? 0, (skip ?? 0) + (take ?? all.length));
      }),
      count: vi.fn(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async ({ where }: any) =>
          [...rows.values()].filter((r) => r.projectId === where.projectId).length,
      ),
    },
  },
}));

import {
  getPrReviewState,
  upsertPrReviewState,
  listPrReviewStatesForProject,
} from "./state-repo.js";

beforeEach(() => {
  rows.clear();
});

describe("upsertPrReviewState", () => {
  it("inserts a new row when none exists", async () => {
    const out = await upsertPrReviewState({
      projectId: "p1",
      repoOwner: "o",
      repoName: "r",
      prNumber: 1,
      lastReviewedSha: "deadbeef",
      acVerdicts: [
        { acId: "AC1", verdict: "satisfied", reasoning: "ok", evidenceFiles: ["src/a.ts"] },
      ],
      lastRunId: "run_1",
      lastVerdict: "approve",
    });
    expect(out.lastReviewedSha).toBe("deadbeef");
    expect(out.acVerdicts).toHaveLength(1);
    expect(out.acVerdicts[0].acId).toBe("AC1");
    expect(out.lastVerdict).toBe("approve");
  });

  it("updates an existing row on second upsert", async () => {
    await upsertPrReviewState({
      projectId: "p1",
      repoOwner: "o",
      repoName: "r",
      prNumber: 1,
      lastReviewedSha: "aaa",
      acVerdicts: [],
      lastRunId: "run_1",
      lastVerdict: "comment",
    });
    const second = await upsertPrReviewState({
      projectId: "p1",
      repoOwner: "o",
      repoName: "r",
      prNumber: 1,
      lastReviewedSha: "bbb",
      acVerdicts: [
        { acId: "X", verdict: "not_satisfied", reasoning: "fail", evidenceFiles: ["src/x.ts"] },
      ],
      lastRunId: "run_2",
      lastVerdict: "request_changes",
    });
    expect(second.lastReviewedSha).toBe("bbb");
    expect(second.acVerdicts[0].verdict).toBe("not_satisfied");
  });
});

describe("getPrReviewState", () => {
  it("returns null when no row exists", async () => {
    const out = await getPrReviewState({
      projectId: "missing",
      repoOwner: "o",
      repoName: "r",
      prNumber: 99,
    });
    expect(out).toBeNull();
  });

  it("parses malformed acVerdictsJson into an empty array", async () => {
    rows.set(key({ projectId: "p1", repoOwner: "o", repoName: "r", prNumber: 1 }), {
      id: "prs_x",
      projectId: "p1",
      repoOwner: "o",
      repoName: "r",
      prNumber: 1,
      lastReviewedSha: null,
      acVerdictsJson: "not json {{{",
      lastRunId: null,
      lastVerdict: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const out = await getPrReviewState({
      projectId: "p1",
      repoOwner: "o",
      repoName: "r",
      prNumber: 1,
    });
    expect(out?.acVerdicts).toEqual([]);
  });

  it("normalizes unknown verdict values to 'uncertain' and missing arrays to []", async () => {
    rows.set(key({ projectId: "p1", repoOwner: "o", repoName: "r", prNumber: 2 }), {
      id: "prs_y",
      projectId: "p1",
      repoOwner: "o",
      repoName: "r",
      prNumber: 2,
      lastReviewedSha: "abc",
      acVerdictsJson: JSON.stringify([
        { acId: "AC1", verdict: "weird", reasoning: "?" },
        { acId: "AC2" },
        null,
        "not-an-object",
      ]),
      lastRunId: null,
      lastVerdict: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const out = await getPrReviewState({
      projectId: "p1",
      repoOwner: "o",
      repoName: "r",
      prNumber: 2,
    });
    expect(out?.acVerdicts).toHaveLength(2);
    expect(out?.acVerdicts[0].verdict).toBe("uncertain");
    expect(out?.acVerdicts[1].evidenceFiles).toEqual([]);
  });

  it("returns [] when acVerdictsJson is non-array JSON", async () => {
    rows.set(key({ projectId: "p1", repoOwner: "o", repoName: "r", prNumber: 3 }), {
      id: "prs_z",
      projectId: "p1",
      repoOwner: "o",
      repoName: "r",
      prNumber: 3,
      lastReviewedSha: null,
      acVerdictsJson: '{"notArray":true}',
      lastRunId: null,
      lastVerdict: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const out = await getPrReviewState({
      projectId: "p1",
      repoOwner: "o",
      repoName: "r",
      prNumber: 3,
    });
    expect(out?.acVerdicts).toEqual([]);
  });
});

describe("listPrReviewStatesForProject", () => {
  it("returns rows scoped to the project ordered by updatedAt desc", async () => {
    await upsertPrReviewState({
      projectId: "p1",
      repoOwner: "o",
      repoName: "r",
      prNumber: 10,
      lastReviewedSha: null,
      acVerdicts: [],
      lastRunId: null,
      lastVerdict: null,
    });
    await upsertPrReviewState({
      projectId: "p2",
      repoOwner: "o",
      repoName: "r",
      prNumber: 20,
      lastReviewedSha: null,
      acVerdicts: [],
      lastRunId: null,
      lastVerdict: null,
    });
    const out = await listPrReviewStatesForProject("p1");
    expect(out.total).toBe(1);
    expect(out.items[0].prNumber).toBe(10);
  });

  it("respects limit + offset clamp", async () => {
    for (let i = 0; i < 5; i += 1) {
      await upsertPrReviewState({
        projectId: "pX",
        repoOwner: "o",
        repoName: "r",
        prNumber: i,
        lastReviewedSha: null,
        acVerdicts: [],
        lastRunId: null,
        lastVerdict: null,
      });
    }
    const out = await listPrReviewStatesForProject("pX", { limit: 2, offset: 1 });
    expect(out.total).toBe(5);
    expect(out.items).toHaveLength(2);
  });

  it("clamps limit to allowed range and negative offsets to zero", async () => {
    await upsertPrReviewState({
      projectId: "pZ",
      repoOwner: "o",
      repoName: "r",
      prNumber: 1,
      lastReviewedSha: null,
      acVerdicts: [],
      lastRunId: null,
      lastVerdict: null,
    });
    const a = await listPrReviewStatesForProject("pZ", { limit: 99999, offset: -10 });
    expect(a.items).toHaveLength(1);
    const b = await listPrReviewStatesForProject("pZ", { limit: 0, offset: 0 });
    expect(b.items).toHaveLength(1); // clamped to >= 1
  });
});
