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
/** #362 — approval-checkpoint counts by status for the gated-analysis cases. */
const approvalCounts: Record<string, number> = { pending: 0, rejected: 0 };
let nextId = 0;

const fakeProject = { id: "proj_1", name: "Apollo", deletedAt: null as Date | null };
const fakeAnalysis = {
  id: "analysis_1",
  projectId: "proj_1",
  startedAt: new Date("2026-09-29T14:05:00.000Z"),
  metadata: JSON.stringify({ extraInstructions: "Self-service password reset\nDetails…" }) as
    string | null,
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
    approvalRequest: {
      count: vi.fn(
        async ({ where }: { where: { status: string } }) => approvalCounts[where.status] ?? 0,
      ),
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
  approvalCounts.pending = 0;
  approvalCounts.rejected = 0;
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

  // #23 — the epic is titled from the analysed feature, never the analysis id.
  it("titles the epic from the analysed feature and names it as each feature's parent", async () => {
    await generateDrafts({
      projectId: "proj_1",
      analysisId: "analysis_1",
      targetOwner: "acme",
      targetRepo: "metis",
    });
    const rows = [...drafts.values()];
    const epic = rows.find((d) => d.draftType === "epic");
    expect(epic?.title).toBe("[Epic] Apollo — Self-service password reset");
    expect(epic?.title).not.toContain("analysis");
    const features = rows.filter((d) => d.draftType !== "epic");
    expect(features.length).toBe(2);
    for (const f of features) {
      expect(f.body).toContain("> Parent epic: **[Epic] Apollo — Self-service password reset**");
    }
  });

  it("falls back to the run's start time when the analysis names no feature", async () => {
    const saved = fakeAnalysis.metadata;
    fakeAnalysis.metadata = null;
    try {
      await generateDrafts({
        projectId: "proj_1",
        analysisId: "analysis_1",
        targetOwner: "acme",
        targetRepo: "metis",
      });
    } finally {
      fakeAnalysis.metadata = saved;
    }
    const epic = [...drafts.values()].find((d) => d.draftType === "epic");
    expect(epic?.title).toBe("[Epic] Apollo — Analysis of 2026-09-29 14:05:00 UTC");
  });

  // #23 review — the epic title is also its dedup key (the publisher recomputes
  // the hash from the title), so two analyses whose requirement text opens with
  // the same line must not share an epic draft: B would overwrite A's body and
  // metadata while keeping A's approved/published status, and publishing would
  // then edit A's GitHub epic in place.
  it("never merges the epic drafts of two analyses that share a first line", async () => {
    const opts = { projectId: "proj_1", targetOwner: "acme", targetRepo: "metis" };
    await generateDrafts({ ...opts, analysisId: "analysis_1" });
    const epicA = [...drafts.values()].find((d) => d.draftType === "epic");
    if (!epicA) throw new Error("epic A missing");
    epicA.status = "published";
    const snapshotA = { ...epicA };

    const savedId = fakeAnalysis.id;
    const savedStart = fakeAnalysis.startedAt;
    fakeAnalysis.id = "analysis_2";
    fakeAnalysis.startedAt = new Date("2026-09-29T15:00:00.000Z");
    try {
      const runB = await generateDrafts({ ...opts, analysisId: "analysis_2" });
      expect(runB.epics).toBe(1);
      // Re-running B refreshes B's epic; it does not mint a third one.
      await generateDrafts({ ...opts, analysisId: "analysis_2" });
    } finally {
      fakeAnalysis.id = savedId;
      fakeAnalysis.startedAt = savedStart;
    }

    const epics = [...drafts.values()].filter((d) => d.draftType === "epic");
    expect(epics).toHaveLength(2);
    expect(drafts.get(epicA.id)).toEqual(snapshotA);
    const epicB = epics.find((d) => d.id !== epicA.id);
    expect(epicB?.title).not.toBe(epicA.title);
    expect(epicB?.dedupHash).not.toBe(epicA.dedupHash);
    expect(epicB?.title).toBe("[Epic] Apollo — Self-service password reset (2)");
    expect(JSON.parse(epicB?.metadata ?? "{}").analysisId).toBe("analysis_2");
    expect(epicB?.status).toBe("draft");
  });

  it("treats an epic draft with unreadable metadata as another analysis's", async () => {
    const opts = { projectId: "proj_1", targetOwner: "acme", targetRepo: "metis" };
    await generateDrafts({ ...opts, analysisId: "analysis_1" });
    const epic = [...drafts.values()].find((d) => d.draftType === "epic");
    if (!epic) throw new Error("epic missing");
    epic.metadata = "{not json";
    await generateDrafts({ ...opts, analysisId: "analysis_1" });
    const titles = [...drafts.values()].filter((d) => d.draftType === "epic").map((d) => d.title);
    expect(titles).toEqual([
      "[Epic] Apollo — Self-service password reset",
      "[Epic] Apollo — Self-service password reset (2)",
    ]);
  });

  // #369 — a feature draft's title is its dedup key too (`[Type] <requirement
  // title>`), so two analyses with a same-titled requirement shared one draft:
  // B overwrote A's body, analysis id and requirement ids while keeping A's
  // approved/published status, and publishing B then edited A's GitHub issue.
  it("never merges the feature drafts of two analyses whose requirements share a title", async () => {
    const opts = { projectId: "proj_1", targetOwner: "acme", targetRepo: "metis" };
    await generateDrafts({ ...opts, analysisId: "analysis_1" });
    const featuresA = [...drafts.values()].filter((d) => d.draftType !== "epic");
    expect(featuresA).toHaveLength(2);
    for (const f of featuresA) f.status = "published";
    const snapshotsA = featuresA.map((f) => ({ ...f }));

    const savedId = fakeAnalysis.id;
    fakeAnalysis.id = "analysis_2";
    try {
      const runB = await generateDrafts({ ...opts, analysisId: "analysis_2" });
      expect(runB.features).toBe(2);
      expect(runB.upserted).toBe(3);
      expect(runB.refreshed).toBe(0);
      // Re-running B refreshes B's own drafts; it mints no fourth set.
      const rerunB = await generateDrafts({ ...opts, analysisId: "analysis_2" });
      expect(rerunB.upserted).toBe(0);
      expect(rerunB.refreshed).toBe(3);
    } finally {
      fakeAnalysis.id = savedId;
    }

    expect(drafts.size).toBe(6);
    for (const snap of snapshotsA) expect(drafts.get(snap.id)).toEqual(snap);
    const featuresB = [...drafts.values()].filter(
      (d) => d.draftType !== "epic" && JSON.parse(d.metadata ?? "{}").analysisId === "analysis_2",
    );
    expect(featuresB.map((f) => f.title).sort()).toEqual([
      "[Feature] Login form (2)",
      "[Task] Logout button (2)",
    ]);
    const hashesA = new Set(featuresA.map((f) => f.dedupHash));
    for (const f of featuresB) {
      expect(hashesA.has(f.dedupHash)).toBe(false);
      expect(f.status).toBe("draft");
    }
  });

  // #395 — two requirements with the same `[Type] <title>` in ONE analysis used
  // to share a draft: the second upsert overwrote the first's body while the
  // draft kept the first's requirementId, leaving one requirement draftless.
  describe("same-titled requirements within one analysis (#395)", () => {
    const opts = {
      projectId: "proj_1",
      analysisId: "analysis_1",
      targetOwner: "acme",
      targetRepo: "metis",
    };
    const twin = {
      ...requirements[0],
      id: "req_twin",
      body: "Given a returning visitor\nWhen they use a passkey\nThen a session is created",
    };

    beforeEach(() => {
      requirements.push(twin);
    });
    afterEach(() => {
      requirements.splice(requirements.indexOf(twin), 1);
    });

    function featureFor(requirementId: string): Draft {
      const found = [...drafts.values()].filter(
        (d) => d.draftType !== "epic" && d.requirementId === requirementId,
      );
      expect(found).toHaveLength(1);
      return found[0];
    }

    it("gives each same-titled requirement its own draft, id and body", async () => {
      const run = await generateDrafts(opts);
      expect(run.features).toBe(3);
      expect(run.upserted).toBe(4);
      expect(drafts.size).toBe(4);

      const first = featureFor("req_1");
      const second = featureFor("req_twin");
      expect(first.id).not.toBe(second.id);
      expect(first.title).toBe("[Feature] Login form");
      expect(second.title).toBe("[Feature] Login form (2)");
      expect(first.body).toContain("they submit credentials");
      expect(first.body).not.toContain("passkey");
      expect(second.body).toContain("passkey");
      expect(JSON.parse(second.metadata ?? "{}").requirementId).toBe("req_twin");
    });

    it("refreshes both drafts on a re-run without duplicating either", async () => {
      await generateDrafts(opts);
      const before = [...drafts.values()].map((d) => ({ id: d.id, req: d.requirementId }));

      const rerun = await generateDrafts(opts);
      expect(rerun.upserted).toBe(0);
      expect(rerun.refreshed).toBe(4);
      expect([...drafts.values()].map((d) => ({ id: d.id, req: d.requirementId }))).toEqual(before);
      expect(featureFor("req_twin").body).toContain("passkey");
      expect(featureFor("req_1").body).not.toContain("passkey");
    });

    it("re-links the drafts when a re-run of the analysis replaces the requirement rows", async () => {
      await generateDrafts(opts);
      const ids = [...drafts.values()].map((d) => d.id).sort();
      // persistRequirements hard-deletes and re-creates the rows; the FK is
      // ON DELETE SET NULL, so every feature draft loses its requirementId.
      for (const d of drafts.values()) d.requirementId = null;
      const saved = requirements.map((r) => r.id);
      requirements.forEach((r) => (r.id = `${r.id}_v2`));
      try {
        const rerun = await generateDrafts(opts);
        expect(rerun.upserted).toBe(0);
        expect(rerun.refreshed).toBe(4);
        expect([...drafts.values()].map((d) => d.id).sort()).toEqual(ids);
        expect(featureFor("req_1_v2").body).not.toContain("passkey");
        expect(featureFor("req_twin_v2").body).toContain("passkey");
        expect(featureFor("req_2_v2").title).toBe("[Task] Logout button");
      } finally {
        requirements.forEach((r, i) => (r.id = saved[i]));
      }
    });

    // #490 — a re-run: fresh ids, every feature draft unlinked, twin sorted first.
    async function rerunSwapped(
      edit: (r: (typeof requirements)[number]) => void = () => {},
      thenRegenerate = 0,
    ) {
      for (const d of drafts.values()) d.requirementId = null;
      const order = [...requirements];
      const saved = requirements.map((r) => [r, r.id, r.body] as const);
      requirements.splice(requirements.indexOf(twin), 1);
      requirements.unshift(twin);
      requirements.forEach((r) => {
        r.id = `${r.id}_v2`;
        edit(r);
      });
      try {
        await generateDrafts(opts);
        // POST /drafts/generate is repeatable: later runs see the drafts linked.
        for (let i = 0; i < thenRegenerate; i++) await generateDrafts(opts);
      } finally {
        for (const [r, id, body] of saved) Object.assign(r, { id, body });
        requirements.splice(0, requirements.length, ...order);
      }
    }

    it("matches a re-run's twins to their own drafts by content, whatever their order (#490)", async () => {
      await generateDrafts(opts);
      const firstId = featureFor("req_1").id;
      await rerunSwapped();
      expect(featureFor("req_1_v2").id).toBe(firstId);
      expect(featureFor("req_1_v2").body).not.toContain("passkey");
      expect(featureFor("req_twin_v2").body).toContain("passkey");
      expect(drafts.size).toBe(4);
    });

    it("keeps a changed twin off the draft its unchanged sibling will claim (#490)", async () => {
      await generateDrafts(opts);
      const firstId = featureFor("req_1").id;
      await rerunSwapped((r) => {
        if (r === twin) r.body = `${r.body} — reworded`;
      });
      expect(featureFor("req_1_v2").id).toBe(firstId);
      expect(featureFor("req_twin_v2").body).toContain("reworded");
      expect(featureFor("req_1_v2").body).not.toContain("passkey");
    });

    it("refreshes an unapproved draft re-linked to changed content (#490)", async () => {
      await generateDrafts(opts);
      await rerunSwapped((r) => {
        r.body = `${r.body} — reworded`;
      });
      for (const d of drafts.values()) {
        if (d.draftType !== "epic") expect(d.body).toContain("reworded");
      }
    });

    it("keeps a signed-off draft's body when it is re-linked to changed content (#490)", async () => {
      await generateDrafts(opts);
      const signedOff = [...drafts.values()].filter((d) => d.draftType !== "epic");
      const before = new Map(signedOff.map((d) => [d.id, d.body]));
      signedOff[0].status = "approved";
      signedOff[1].status = "published";
      // A draft generated before #490 carries no requirementKey at all.
      signedOff[2].status = "publishing";
      signedOff[2].metadata = JSON.stringify({ analysisId: "analysis_1" });
      await rerunSwapped((r) => {
        r.body = `${r.body} — reworded`;
      });
      for (const d of signedOff) {
        const now = drafts.get(d.id)!;
        expect(now.body).toBe(before.get(d.id));
        expect(now.requirementId).toMatch(/_v2$/);
        expect(now.status).toBe(d.status);
        expect(JSON.parse(now.metadata ?? "{}").requirementId).toBe(now.requirementId);
      }
      expect(JSON.parse(drafts.get(signedOff[2].id)!.metadata ?? "{}").requirementKey).toBe(
        undefined,
      );
    });

    it("keeps holding a signed-off body on every later Generate after the re-link (#490)", async () => {
      await generateDrafts(opts);
      const signedOff = [...drafts.values()].filter((d) => d.draftType !== "epic");
      const before = new Map(signedOff.map((d) => [d.id, d.body]));
      signedOff[0].status = "approved";
      signedOff[1].status = "published";
      signedOff[2].status = "publishing";
      signedOff[2].metadata = JSON.stringify({ analysisId: "analysis_1" });
      await rerunSwapped((r) => {
        r.body = `${r.body} — reworded`;
      }, 2);
      for (const d of signedOff) {
        const now = drafts.get(d.id)!;
        expect(now.body).toBe(before.get(d.id));
        expect(now.requirementId).toMatch(/_v2$/);
        expect(JSON.parse(now.metadata ?? "{}").bodyHeld).toBe(true);
      }
    });

    it("still refreshes a linked, never-held published draft when its requirement is edited (#490)", async () => {
      await generateDrafts(opts);
      const published = featureFor("req_1");
      published.status = "published";
      const saved = requirements[0].body;
      requirements[0].body = `${saved} — clarified`;
      try {
        await generateDrafts(opts);
      } finally {
        requirements[0].body = saved;
      }
      const now = drafts.get(published.id)!;
      expect(now.body).toContain("clarified");
      expect(now.status).toBe("published");
      expect(JSON.parse(now.metadata ?? "{}").bodyHeld).toBeUndefined();
    });

    it("never hands a draft linked to another requirement of the same analysis to this one", async () => {
      await generateDrafts(opts);
      const firstId = featureFor("req_1").id;
      // The twin now sorts ahead of req_1; it must still land on its own draft.
      requirements.splice(requirements.indexOf(twin), 1);
      requirements.unshift(twin);
      try {
        await generateDrafts(opts);
      } finally {
        requirements.splice(requirements.indexOf(twin), 1);
        requirements.push(twin);
      }
      expect(featureFor("req_1").id).toBe(firstId);
      expect(featureFor("req_1").body).not.toContain("passkey");
      expect(featureFor("req_twin").body).toContain("passkey");
      expect(drafts.size).toBe(4);
    });
  });

  // #369 — `claimTitle` is check-then-act; the partial unique index on
  // (projectId, dedupHash) is what makes the loser of a concurrent claim fail,
  // and the generator must then re-claim rather than surface a 500.
  describe("concurrent title claims (unique-index violation)", () => {
    const opts = { projectId: "proj_1", targetOwner: "acme", targetRepo: "metis" };

    /** Make the next create for `title` lose a race to a row owned by `winner`. */
    async function loseRaceOn(title: string, winnerAnalysisId: string) {
      const { prisma } = await import("../src/lib/prisma.js");
      const create = vi.mocked(prisma.issueDraft.create);
      const real = create.getMockImplementation()!;
      create.mockImplementation((async (args: { data: Partial<Draft> }) => {
        if (args.data.title !== title) return real(args as never);
        create.mockImplementation(real);
        // The concurrent generator's row lands first…
        await real({
          data: {
            ...args.data,
            status: "approved",
            metadata: JSON.stringify({ analysisId: winnerAnalysisId }),
          },
        } as never);
        // …so ours hits the unique index.
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }) as never);
    }

    it("re-claims the next free title when another analysis wins the race", async () => {
      await loseRaceOn("[Epic] Apollo — Self-service password reset", "analysis_9");
      const run = await generateDrafts({ ...opts, analysisId: "analysis_1" });
      expect(run.epics).toBe(1);
      const epics = [...drafts.values()].filter((d) => d.draftType === "epic");
      expect(epics.map((e) => e.title).sort()).toEqual([
        "[Epic] Apollo — Self-service password reset",
        "[Epic] Apollo — Self-service password reset (2)",
      ]);
      const ours = epics.find((e) => JSON.parse(e.metadata ?? "{}").analysisId === "analysis_1");
      expect(ours?.title).toBe("[Epic] Apollo — Self-service password reset (2)");
      // Features name the title the epic actually got, not the one it lost.
      for (const f of [...drafts.values()].filter((d) => d.draftType !== "epic")) {
        expect(f.body).toContain(
          "> Parent epic: **[Epic] Apollo — Self-service password reset (2)**",
        );
      }
    });

    it("refreshes the winner's draft when the same analysis won the race", async () => {
      await loseRaceOn("[Feature] Login form", "analysis_1");
      const run = await generateDrafts({ ...opts, analysisId: "analysis_1" });
      expect(run.refreshed).toBe(1);
      const logins = [...drafts.values()].filter((d) => d.title.startsWith("[Feature] Login form"));
      expect(logins).toHaveLength(1);
      expect(logins[0].status).toBe("approved");
    });

    it("rethrows an error that is not a unique-index violation", async () => {
      const { prisma } = await import("../src/lib/prisma.js");
      vi.mocked(prisma.issueDraft.create).mockRejectedValueOnce(new Error("disk full"));
      await expect(generateDrafts({ ...opts, analysisId: "analysis_1" })).rejects.toThrow(
        "disk full",
      );
    });

    it("gives up after a bounded number of lost races", async () => {
      const { prisma } = await import("../src/lib/prisma.js");
      const conflict = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      const create = vi.mocked(prisma.issueDraft.create);
      const real = create.getMockImplementation()!;
      create.mockRejectedValue(conflict);
      try {
        await expect(generateDrafts({ ...opts, analysisId: "analysis_1" })).rejects.toBe(conflict);
        expect(create.mock.calls.length).toBe(5);
      } finally {
        create.mockImplementation(real);
      }
    });
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
      ).rejects.toMatchObject({ status: 400, code: "NO_REQUIREMENTS" });

      // #362 — a completed analysis whose requirements the approval gate is
      // withholding names that precondition, not "run analysis first".
      approvalCounts.pending = 3;
      const gated = await generateDrafts({
        projectId: "proj_1",
        analysisId: "analysis_1",
        targetOwner: "acme",
        targetRepo: "metis",
      }).catch((e: unknown) => e);
      expect(gated).toBeInstanceOf(PublishError);
      expect(gated).toMatchObject({
        status: 400,
        code: "APPROVALS_BLOCKING",
        details: {
          analysisId: "analysis_1",
          pendingCount: 3,
          rejectedCount: 0,
          action: "resolve",
        },
      });
      // #406 — ids and counts only: the UI builds its own route, so there is
      // no server-made URL for it to guard against.
      expect((gated as PublishError).details).not.toHaveProperty("resolveUrl");
      const message = (gated as PublishError).message;
      expect(message).toContain("3 pending");
      expect(message).not.toContain("rejected");
      expect(message).toContain("Analysis page");
      expect(message).not.toContain("run analysis first");

      // PR #404 panel — a rejection is final, so any rejected checkpoint means
      // this run can never produce requirements: point at a new run, not at the
      // approvals panel, even while other approvals are still pending.
      approvalCounts.rejected = 1;
      const rejected = await generateDrafts({
        projectId: "proj_1",
        analysisId: "analysis_1",
        targetOwner: "acme",
        targetRepo: "metis",
      }).catch((e: unknown) => e);
      expect(rejected).toMatchObject({
        code: "APPROVALS_BLOCKING",
        message: expect.stringContaining("1 approval(s) were rejected"),
        details: {
          pendingCount: 3,
          rejectedCount: 1,
          action: "rerun",
        },
      });
      expect((rejected as PublishError).details).not.toHaveProperty("resolveUrl");
      expect((rejected as PublishError).message).toContain("re-run the analysis");
      expect((rejected as PublishError).message).not.toContain("resolve them");

      // Rejected alone: the same re-run remedy.
      approvalCounts.pending = 0;
      await expect(
        generateDrafts({
          projectId: "proj_1",
          analysisId: "analysis_1",
          targetOwner: "acme",
          targetRepo: "metis",
        }),
      ).rejects.toMatchObject({
        code: "APPROVALS_BLOCKING",
        details: { action: "rerun" },
      });
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
