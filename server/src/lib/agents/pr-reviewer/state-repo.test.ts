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
  recordPrReviewOutcome,
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

describe("recordPrReviewOutcome (#1470)", () => {
  const K = { projectId: "p1", repoOwner: "acme", repoName: "site", prNumber: 9 };
  const reviewed = {
    status: "reviewed" as const,
    headSha: "sha1",
    acVerdicts: [
      { acId: "AC-1", verdict: "satisfied" as const, reasoning: "ok", evidenceFiles: ["a.ts"] },
    ],
    runId: "run_1",
    verdict: "approve" as const,
    reviewUrl: "https://github.com/acme/site/pull/9#pullrequestreview-1",
  };

  it("a completed review writes every field the page and the incremental path read", async () => {
    const out = await recordPrReviewOutcome(K, reviewed);
    expect(out).toMatchObject({
      lastStatus: "reviewed",
      lastSkipReason: null,
      lastReviewedSha: "sha1",
      lastRunId: "run_1",
      lastVerdict: "approve",
      lastReviewUrl: reviewed.reviewUrl,
    });
    expect(out.acVerdicts).toHaveLength(1);
  });

  it("a skip on a new PR creates the row with only the status and reason", async () => {
    const out = await recordPrReviewOutcome(K, { status: "skipped", reason: "no_linked_issue" });
    expect(out).toMatchObject({
      lastStatus: "skipped",
      lastSkipReason: "no_linked_issue",
      lastReviewUrl: null,
      acVerdicts: [],
    });
    // Nothing else is written (the column defaults apply; this mock has none).
    const created = rows.get("p1|acme|site|9")!;
    expect(Object.keys(created).sort()).toEqual(
      [
        "id",
        "createdAt",
        "updatedAt",
        "projectId",
        "repoOwner",
        "repoName",
        "prNumber",
        "lastStatus",
        "lastSkipReason",
      ].sort(),
    );
  });

  it("a skip after a review keeps the posted review's verdict, link, SHA and run", async () => {
    await recordPrReviewOutcome(K, reviewed);
    const out = await recordPrReviewOutcome(K, { status: "skipped", reason: "budget_exceeded" });
    expect(out).toMatchObject({
      lastStatus: "skipped",
      lastSkipReason: "budget_exceeded",
      lastVerdict: "approve",
      lastReviewUrl: reviewed.reviewUrl,
      lastReviewedSha: "sha1",
      lastRunId: "run_1",
    });
    expect(out.acVerdicts).toHaveLength(1);
  });

  it("a failure points at its run and clears a stale skip reason, keeping the posted review", async () => {
    await recordPrReviewOutcome(K, reviewed);
    await recordPrReviewOutcome(K, { status: "skipped", reason: "budget_exceeded" });
    const out = await recordPrReviewOutcome(K, { status: "failed", runId: "run_2" });
    expect(out).toMatchObject({
      lastStatus: "failed",
      lastSkipReason: null,
      lastRunId: "run_2",
      lastVerdict: "approve",
      lastReviewUrl: reviewed.reviewUrl,
    });
  });

  it("a new review after a skip clears the skip reason", async () => {
    await recordPrReviewOutcome(K, { status: "skipped", reason: "diff_too_large" });
    const out = await recordPrReviewOutcome(K, { ...reviewed, verdict: "request_changes" });
    expect(out).toMatchObject({
      lastStatus: "reviewed",
      lastSkipReason: null,
      lastVerdict: "request_changes",
    });
  });

  it("reads an unknown stored status as no status", async () => {
    rows.set("p1|acme|site|10", {
      id: "prs_x",
      projectId: "p1",
      repoOwner: "acme",
      repoName: "site",
      prNumber: 10,
      lastReviewedSha: null,
      acVerdictsJson: "[]",
      lastRunId: null,
      lastVerdict: null,
      lastStatus: "bogus",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const out = await getPrReviewState({ ...K, prNumber: 10 });
    expect(out).toMatchObject({ lastStatus: null, lastSkipReason: null, lastReviewUrl: null });
  });
});
