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
/** #362 — `requirement` approval counts by status for the gated-analysis cases. */
const approvalCounts: Record<string, number> = { pending: 0, rejected: 0 };
/** #723 — every OTHER approval type (evidence, clarification), by type then status. */
const otherApprovalCounts: Record<string, Record<string, number>> = {};
let nextId = 0;
/** #1064 — `requirement_code_mappings` rows, as the generator's select returns them. */
const codeMappings: Array<{
  requirementId: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  codeSymbol: { name: string; kind: string } | null;
}> = [];
const repoConnections: Array<Record<string, string | null>> = [];

const fakeProject = { id: "proj_1", name: "Apollo", deletedAt: null as Date | null };
const fakeAnalysis = {
  id: "analysis_1",
  projectId: "proj_1",
  status: "completed",
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
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId?: string } }) =>
        where.id === fakeAnalysis.id && where.projectId === fakeAnalysis.projectId
          ? fakeAnalysis
          : null,
      ),
    },
    requirement: {
      findMany: vi.fn(async () => requirements),
    },
    // #1064 — the persisted code links and the repository they link into.
    requirementCodeMapping: {
      findMany: vi.fn(
        async ({ where, take }: { where: { requirementId: string }; take?: number }) =>
          codeMappings.filter((m) => m.requirementId === where.requirementId).slice(0, take),
      ),
      count: vi.fn(
        async ({ where }: { where: { requirementId: string } }) =>
          codeMappings.filter((m) => m.requirementId === where.requirementId).length,
      ),
    },
    repoConnection: { findMany: vi.fn(async () => repoConnections) },
    approvalRequest: {
      // Honours `type`: a query without one (the gate) counts every type; a
      // `type: "requirement"` query counts only the requirement approvals.
      count: vi.fn(async ({ where }: { where: { status: string; type?: string } }) => {
        const requirementCount = approvalCounts[where.status] ?? 0;
        if (where.type === "requirement") return requirementCount;
        if (where.type) return otherApprovalCounts[where.type]?.[where.status] ?? 0;
        return Object.values(otherApprovalCounts).reduce(
          (sum, byStatus) => sum + (byStatus[where.status] ?? 0),
          requirementCount,
        );
      }),
    },
    issueDraft: {
      // #1276 — the epic drafts of a project, to find this analysis's recorded epic title.
      findMany: vi.fn(async ({ where }: { where: { projectId?: string; draftType?: string } }) =>
        [...drafts.values()].filter(
          (d) =>
            !d.deletedAt &&
            (where.projectId === undefined || d.projectId === where.projectId) &&
            (where.draftType === undefined || d.draftType === where.draftType),
        ),
      ),
      findFirst: vi.fn(async ({ where }: { where: { dedupHash?: string } }) => {
        if (!where.dedupHash) return null;
        for (const d of drafts.values()) {
          if (d.dedupHash === where.dedupHash && !d.deletedAt) return d;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Partial<Draft> }) => {
        nextId += 1;
        const row: Draft = Object.assign(
          {
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
          },
          data,
        );
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

// #723 — publishing promotes a stranded run's approved requirements first.
const promoteApprovedRequirements = vi.hoisted(() =>
  vi.fn(async (_analysisId: string): Promise<Record<string, unknown>> => ({
    status: "unavailable",
    reason: "This analysis has no usable synthesis output to promote.",
  })),
);
vi.mock("../src/lib/analysis/promote-requirements.js", () => ({
  promoteApprovedRequirements,
}));
// #1230 — a promoted set asks the reader-BRD staleness check to look again.
const noteRequirementsChanged = vi.hoisted(() => vi.fn(async (_ids: readonly string[]) => {}));
vi.mock("../src/lib/docs-gen/approved-requirements-staleness.js", () => ({
  noteRequirementsChanged,
}));

import {
  estimateStoryPoints,
  featureDraftTitle,
  generateDrafts,
  listDraftCandidates,
} from "../src/lib/publishing/draft-generator.js";
import { DRAFT_SELECTION_THRESHOLD } from "@metis/shared";
import { prisma } from "../src/lib/prisma.js";
import { PublishError } from "../src/lib/publishing/types.js";
import { computeDedupHash } from "../src/lib/publishing/dedup.js";
import {
  assertCodeLinksMatchTarget,
  bodyWithCodeAsText,
} from "../src/lib/publishing/draft-code-links.js";
import { planApprovedRequirementSet } from "../src/lib/analysis/approved-requirement-set.js";
import {
  promotionMatchingRecord,
  sharedCriteriaRecords,
} from "../src/lib/analysis/promotion-matching.js";

beforeEach(() => {
  drafts.clear();
  codeMappings.length = 0;
  repoConnections.length = 0;
  nextId = 0;
  approvalCounts.pending = 0;
  approvalCounts.rejected = 0;
  for (const type of Object.keys(otherApprovalCounts)) delete otherApprovalCounts[type];
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

  it("#733 — records the target each draft was generated for, epic and features alike", async () => {
    await generateDrafts({
      projectId: "proj_1",
      analysisId: "analysis_1",
      targetOwner: "openzigs",
      targetRepo: "flux-v2",
    });
    expect(drafts.size).toBe(3);
    for (const d of drafts.values()) {
      const meta = JSON.parse(d.metadata ?? "{}");
      expect(meta.targetOwner).toBe("openzigs");
      expect(meta.targetRepo).toBe("flux-v2");
    }
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

      // Issue #723 — a rejection is a resolution, so while another approval is
      // still pending the remedy is the approvals panel, not a re-run.
      approvalCounts.rejected = 1;
      const rejected = await generateDrafts({
        projectId: "proj_1",
        analysisId: "analysis_1",
        targetOwner: "acme",
        targetRepo: "metis",
      }).catch((e: unknown) => e);
      expect(rejected).toMatchObject({
        code: "APPROVALS_BLOCKING",
        details: { pendingCount: 3, rejectedCount: 1, action: "resolve" },
      });
      expect((rejected as PublishError).message).not.toContain("re-run");

      // Rejected alone: every reviewed requirement was rejected. A rejection can
      // be reopened, so the remedy is still the approvals panel, never a re-run.
      approvalCounts.pending = 0;
      const allRejected = await generateDrafts({
        projectId: "proj_1",
        analysisId: "analysis_1",
        targetOwner: "acme",
        targetRepo: "metis",
      }).catch((e: unknown) => e);
      expect(allRejected).toMatchObject({
        code: "APPROVALS_BLOCKING",
        details: { pendingCount: 0, rejectedCount: 1, action: "resolve" },
      });
      expect((allRejected as PublishError).message).toContain("reopen");
      expect((allRejected as PublishError).message).not.toContain("re-run");
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

  // Issue #723 — a run stranded before rejections counted as resolved: the gate
  // is open, approved requirements exist, and nothing ever re-ran promotion
  // (only the review route did). Publishing must recover it, not tell the
  // reviewer every approval was rejected.
  describe("an open gate with nothing promoted (#723)", () => {
    const saved: typeof requirements = [];
    beforeEach(() => {
      saved.splice(0, saved.length, ...requirements);
      requirements.length = 0;
      approvalCounts.approved = 32;
      approvalCounts.rejected = 1;
    });
    afterEach(() => {
      requirements.splice(0, requirements.length, ...saved);
      delete approvalCounts.approved;
      promoteApprovedRequirements.mockReset();
      promoteApprovedRequirements.mockResolvedValue({
        status: "unavailable",
        reason: "This analysis has no usable synthesis output to promote.",
      });
    });

    it("promotes the approved requirements, then generates drafts from them", async () => {
      promoteApprovedRequirements.mockImplementationOnce(async () => {
        requirements.push(...saved);
        return { status: "promoted", requirementCount: saved.length };
      });

      const summary = await generateDrafts({
        projectId: "proj_1",
        analysisId: "analysis_1",
        targetOwner: "acme",
        targetRepo: "metis",
      });

      expect(promoteApprovedRequirements).toHaveBeenCalledWith("analysis_1");
      expect(summary.features).toBe(2);
      // #1230 — the promoted rows may be what a reader BRD lists.
      expect(noteRequirementsChanged).toHaveBeenCalledWith(saved.map((r) => r.id));
    });

    it("says the approved requirements could not be promoted — never that they were rejected", async () => {
      promoteApprovedRequirements.mockResolvedValueOnce({
        status: "unavailable",
        reason: "This analysis has no usable synthesis output to promote.",
      });

      const err = await generateDrafts({
        projectId: "proj_1",
        analysisId: "analysis_1",
        targetOwner: "acme",
        targetRepo: "metis",
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PublishError);
      const message = (err as PublishError).message;
      expect(message).toContain("32 approved requirement(s) could not be promoted");
      expect(message).toContain("no usable synthesis output");
      expect(message).not.toContain("rejected");
      expect(message).not.toContain("reopen");
    });

    // Mid-run window: synthesis is done but the orchestrator has not saved the
    // requirements yet. Promoting here would race its save (#723 review).
    it.each(["running", "pending"])(
      "does not promote while the analysis is %s — says it is still running",
      async (status) => {
        fakeAnalysis.status = status;
        try {
          const err = await generateDrafts({
            projectId: "proj_1",
            analysisId: "analysis_1",
            targetOwner: "acme",
            targetRepo: "metis",
          }).catch((e: unknown) => e);

          expect(promoteApprovedRequirements).not.toHaveBeenCalled();
          expect(err).toBeInstanceOf(PublishError);
          expect(err).toMatchObject({
            status: 400,
            code: "NO_REQUIREMENTS",
            retryable: true,
            details: { analysisId: "analysis_1", analysisStatus: status },
          });
          expect((err as PublishError).message).toContain("still running");
          expect((err as PublishError).message).not.toContain("could not be promoted");
        } finally {
          fakeAnalysis.status = "completed";
        }
      },
    );

    // A failed or cancelled run is terminal: the orchestrator saves nothing more,
    // and its approvals were resolved — so it promotes, like the promote route.
    it.each(["failed", "cancelled"])(
      "promotes the resolved approvals of a %s analysis",
      async (status) => {
        fakeAnalysis.status = status;
        promoteApprovedRequirements.mockImplementationOnce(async () => {
          requirements.push(...saved);
          return { status: "promoted", requirementCount: saved.length };
        });
        try {
          const summary = await generateDrafts({
            projectId: "proj_1",
            analysisId: "analysis_1",
            targetOwner: "acme",
            targetRepo: "metis",
          });

          expect(promoteApprovedRequirements).toHaveBeenCalledWith("analysis_1");
          expect(summary.features).toBe(2);
        } finally {
          fakeAnalysis.status = "completed";
        }
      },
    );

    it("does not try to promote while approvals are still pending", async () => {
      approvalCounts.pending = 2;

      const err = await generateDrafts({
        projectId: "proj_1",
        analysisId: "analysis_1",
        targetOwner: "acme",
        targetRepo: "metis",
      }).catch((e: unknown) => e);

      expect(promoteApprovedRequirements).not.toHaveBeenCalled();
      expect(err).toMatchObject({ code: "APPROVALS_BLOCKING", details: { pendingCount: 2 } });
    });
  });

  // Issue #723 — only REQUIREMENT approvals decide the message: an evidence or
  // clarification approval/rejection excludes no requirement, so it must never
  // read as "all N reviewed requirement(s) were rejected" (or as approved
  // requirements that could not be promoted).
  it("ignores evidence and clarification approvals when naming the empty set", async () => {
    const saved = requirements.splice(0, requirements.length);
    otherApprovalCounts.evidence = { approved: 2, rejected: 1 };
    otherApprovalCounts.clarification = { rejected: 1 };
    try {
      const err = await generateDrafts({
        projectId: "proj_1",
        analysisId: "analysis_1",
        targetOwner: "acme",
        targetRepo: "metis",
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PublishError);
      const message = (err as PublishError).message;
      expect(message).not.toContain("were rejected");
      expect(message).not.toContain("could not be promoted");
      expect(err).toMatchObject({ code: "NO_REQUIREMENTS" });
      expect(message).toContain("run analysis first");
    } finally {
      requirements.push(...saved);
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

describe("#1064 — code links, hidden ids and the epic's name", () => {
  const opts = {
    projectId: "proj_1",
    analysisId: "analysis_1",
    targetOwner: "acme",
    targetRepo: "metis",
    // Public GitHub, as the batch form sends it when its base URL is empty.
    targetBaseUrl: null as string | null | undefined,
  };
  const feature = (requirementId: string) =>
    [...drafts.values()].find((d) => d.requirementId === requirementId)!;
  const epics = () => [...drafts.values()].filter((d) => d.draftType === "epic");

  it("lists each requirement's persisted code links, linked into the project's repository", async () => {
    codeMappings.push(
      {
        requirementId: "req_1",
        filePath: "server/src/auth/login.ts",
        startLine: 10,
        endLine: 42,
        codeSymbol: { name: "createSession", kind: "function" },
      },
      {
        requirementId: "req_1",
        filePath: "ui/src/login-form.tsx",
        startLine: null,
        endLine: null,
        codeSymbol: null,
      },
    );
    // The drafts are generated FOR the analysed repository (acme/metis).
    repoConnections.push({
      provider: "github",
      ownerOrOrg: "acme",
      repoName: "metis",
      defaultBranch: "main",
      apiBaseUrl: null,
      lastCommitSha: "0123abcd",
    });
    await generateDrafts(opts);

    const linked = feature("req_1").body;
    expect(linked).toContain("## Related code");
    expect(linked).toContain(
      "- [`server/src/auth/login.ts:10-42`](https://github.com/acme/metis/blob/0123abcd/server/src/auth/login.ts#L10-L42) — `createSession` (function)",
    );
    expect(linked).toContain(
      "- [`ui/src/login-form.tsx`](https://github.com/acme/metis/blob/0123abcd/ui/src/login-form.tsx)",
    );
    // The draft records what it links into, so a batch aimed elsewhere is refused.
    const recorded = JSON.parse(feature("req_1").metadata!);
    expect(recorded.codeLinkBase).toBe("https://github.com/acme/metis");
    // …and both renderings of the section its body holds: the linked one is in
    // the body byte for byte, the plain one is what Jira gets in its place.
    expect(linked).toContain(`\n${recorded.codeLinkSection.linked}\n`);
    expect(recorded.codeLinkSection.plain).toContain(
      "- `server/src/auth/login.ts:10-42` — `createSession` (function)\n- `ui/src/login-form.tsx`",
    );
    expect(recorded.codeLinkSection.plain).not.toContain("acme");
    expect(bodyWithCodeAsText(feature("req_1"))).toBe(
      linked.replace(recorded.codeLinkSection.linked, recorded.codeLinkSection.plain),
    );
    // A requirement with no link has nothing to swap, and records no section.
    expect(JSON.parse(feature("req_2").metadata!).codeLinkSection).toBeUndefined();
    // Another requirement's links never appear, and "no link" is said in words.
    const unlinked = feature("req_2").body;
    expect(unlinked).not.toContain("login.ts");
    expect(unlinked).toContain("_METIS recorded no code links for this requirement._");
    // Scoped to the project and to this run's requirements.
    for (const requirementId of ["req_1", "req_2"]) {
      expect(vi.mocked(prisma.requirementCodeMapping.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ where: { projectId: "proj_1", requirementId } }),
      );
    }
    expect(vi.mocked(prisma.requirementCodeMapping.findMany)).toHaveBeenCalledTimes(2);
  });

  it("lists the code as plain text when the publish target is not the analysed repository", async () => {
    codeMappings.push({
      requirementId: "req_1",
      filePath: "server/src/auth/login.ts",
      startLine: 10,
      endLine: 42,
      codeSymbol: { name: "createSession", kind: "function" },
    });
    // Analysed: a private upstream. Published to: acme/metis, a different repository.
    repoConnections.push({
      provider: "github",
      ownerOrOrg: "secretcorp",
      repoName: "private-upstream",
      defaultBranch: "main",
      apiBaseUrl: null,
      lastCommitSha: "0123abcd",
    });
    await generateDrafts(opts);

    const body = feature("req_1").body;
    expect(body).toContain("- `server/src/auth/login.ts:10-42` — `createSession` (function)");
    // Nothing that identifies the analysed repository reaches the other tracker.
    for (const leak of ["secretcorp", "private-upstream", "0123abcd", "https://", "]("]) {
      expect(body).not.toContain(leak);
    }
    expect(body).toContain(
      "_These paths are in the repository METIS analysed. They are written as text, not links, because this issue is not known to be in that repository._",
    );
    expect(JSON.parse(feature("req_1").metadata!).codeLinkBase).toBeUndefined();
    // The epic never carried links, and names no repository either.
    expect(epics()[0]!.body).not.toContain("secretcorp");
  });

  it("keeps the link record with a reviewer-edited body that a re-generate keeps", async () => {
    codeMappings.push({
      requirementId: "req_1",
      filePath: "a.ts",
      startLine: null,
      endLine: null,
      codeSymbol: null,
    });
    repoConnections.push({
      provider: "github",
      ownerOrOrg: "acme",
      repoName: "metis",
      defaultBranch: "main",
      apiBaseUrl: null,
      lastCommitSha: "0123abcd",
    });
    await generateDrafts(opts);
    const draft = feature("req_1");
    const linkedBody = draft.body;
    draft.metadata = JSON.stringify({ ...JSON.parse(draft.metadata!), userEdited: true });
    // The connector is gone on the next Generate: new bodies would be text.
    repoConnections.length = 0;
    await generateDrafts(opts);
    // The edited body (still holding its links) is kept — and so is the record.
    expect(feature("req_1").body).toBe(linkedBody);
    expect(JSON.parse(feature("req_1").metadata!).codeLinkBase).toBe(
      "https://github.com/acme/metis",
    );
    // An unedited sibling was regenerated as text and records nothing.
    expect(JSON.parse(feature("req_2").metadata!).codeLinkBase).toBeUndefined();
  });

  it("keeps the link record with a signed-off body that a re-link holds", async () => {
    codeMappings.push({
      requirementId: "req_1",
      filePath: "a.ts",
      startLine: null,
      endLine: null,
      codeSymbol: null,
    });
    repoConnections.push({
      provider: "github",
      ownerOrOrg: "acme",
      repoName: "metis",
      defaultBranch: "main",
      apiBaseUrl: null,
      lastCommitSha: "0123abcd",
    });
    await generateDrafts(opts);
    const draft = feature("req_1");
    const linkedBody = draft.body;
    expect(linkedBody).toContain("https://github.com/acme/metis/blob/0123abcd/a.ts");
    // Signed off, then the analysis is re-run: the requirement row is replaced
    // (the draft is unlinked) and its text has changed, so the body is HELD.
    draft.status = "approved";
    draft.requirementId = null;
    const saved = { id: requirements[0].id, body: requirements[0].body };
    requirements[0].id = "req_1_v2";
    requirements[0].body = `${saved.body} — reworded`;
    // The connector is gone on this Generate: a new body would be text and
    // would record nothing.
    repoConnections.length = 0;
    try {
      await generateDrafts(opts);
    } finally {
      requirements[0].id = saved.id;
      requirements[0].body = saved.body;
    }
    const held = drafts.get(draft.id)!;
    expect(held.requirementId).toBe("req_1_v2");
    expect(held.body).toBe(linkedBody);
    const meta = JSON.parse(held.metadata!);
    expect(meta.bodyHeld).toBe(true);
    // The body still links into acme/metis, so the record of that stays with
    // it: without it the guard would let this draft into any other repository.
    expect(meta.codeLinkBase).toBe("https://github.com/acme/metis");
    // …and so does the record of the section, or Jira would get the kept body
    // through the edited-section path.
    expect(held.body).toContain(meta.codeLinkSection.linked);
    expect(bodyWithCodeAsText(held)).not.toContain("https://github.com/acme/metis");
    expect(bodyWithCodeAsText(held)).toContain("this issue is not known to be in that repository");
    expect(() =>
      assertCodeLinksMatchTarget([held], { owner: "someone", repo: "public", baseUrl: null }),
    ).toThrow(/links into the analysed repository/);
  });

  it("reads a target with no base URL as public GitHub — the reading batch create gives it", async () => {
    codeMappings.push({
      requirementId: "req_1",
      filePath: "server/src/auth/login.ts",
      startLine: 10,
      endLine: 42,
      codeSymbol: null,
    });
    repoConnections.push({
      provider: "github",
      ownerOrOrg: "acme",
      repoName: "metis",
      defaultBranch: "main",
      apiBaseUrl: null,
      lastCommitSha: "0123abcd",
    });
    const target = { owner: "acme", repo: "metis" };
    // Left out, null and empty are one target, at Generate and for the guard:
    // an API caller that sends the same fields to both gets links and no refusal.
    for (const targetBaseUrl of [undefined, null, ""]) {
      drafts.clear();
      await generateDrafts({ ...opts, targetBaseUrl });
      const label = String(targetBaseUrl);
      expect(feature("req_1").body, label).toContain(
        "- [`server/src/auth/login.ts:10-42`](https://github.com/acme/metis/blob/0123abcd/server/src/auth/login.ts#L10-L42)",
      );
      const generated = [...drafts.values()];
      for (const baseUrl of [undefined, null]) {
        expect(
          () => assertCodeLinksMatchTarget(generated, { ...target, baseUrl }),
          label,
        ).not.toThrow();
      }
      expect(() => assertCodeLinksMatchTarget(generated, target), label).not.toThrow();
    }
  });

  it("writes plain code, and records nothing, for a base URL that is not an https URL", async () => {
    codeMappings.push({
      requirementId: "req_1",
      filePath: "server/src/auth/login.ts",
      startLine: 10,
      endLine: 42,
      codeSymbol: null,
    });
    repoConnections.push({
      provider: "github",
      ownerOrOrg: "acme",
      repoName: "metis",
      defaultBranch: "main",
      apiBaseUrl: null,
      lastCommitSha: "0123abcd",
    });
    // What a half-typed batch-form field holds: Generate does not fail on it.
    for (const targetBaseUrl of ["github.example.com", "http://api.github.com", "https://"]) {
      drafts.clear();
      await generateDrafts({ ...opts, targetBaseUrl });
      const body = feature("req_1").body;
      expect(body, targetBaseUrl).toContain("- `server/src/auth/login.ts:10-42`");
      expect(body, targetBaseUrl).not.toContain("https://");
      const meta = JSON.parse(feature("req_1").metadata!);
      expect(meta.codeLinkBase).toBeUndefined();
      expect(meta.codeLinkSection).toBeUndefined();
    }
  });

  describe("the same owner and repository name on another host", () => {
    const GHE = "https://ghe.example.com/api/v3";
    const onPublicGitHub = { owner: "acme", repo: "metis", baseUrl: null };
    const onEnterprise = { owner: "acme", repo: "metis", baseUrl: GHE };
    const featureDrafts = () => [...drafts.values()].filter((d) => d.draftType !== "epic");

    beforeEach(() => {
      codeMappings.push({
        requirementId: "req_1",
        filePath: "server/src/auth/login.ts",
        startLine: 10,
        endLine: 42,
        codeSymbol: { name: "createSession", kind: "function" },
      });
      // Analysed on GitHub Enterprise; a same-named repository exists on github.com.
      repoConnections.push({
        provider: "github_enterprise",
        ownerOrOrg: "acme",
        repoName: "metis",
        defaultBranch: "main",
        apiBaseUrl: GHE,
        lastCommitSha: "0123abcd",
      });
    });

    it("links only when the drafts are generated for the connector's own host", async () => {
      await generateDrafts({ ...opts, targetBaseUrl: GHE });
      expect(feature("req_1").body).toContain(
        "- [`server/src/auth/login.ts:10-42`](https://ghe.example.com/acme/metis/blob/0123abcd/server/src/auth/login.ts#L10-L42)",
      );
      expect(JSON.parse(feature("req_1").metadata!).codeLinkBase).toBe(
        "https://ghe.example.com/acme/metis",
      );
      expect(() => assertCodeLinksMatchTarget(featureDrafts(), onEnterprise)).not.toThrow();
    });

    it("generated for github.com, the drafts carry no link and are never refused there", async () => {
      // Before: names matched, so links were written, and the batch was refused.
      // A base URL that was left out is github.com too, so it is no way round.
      for (const targetBaseUrl of [null, undefined]) {
        drafts.clear();
        await generateDrafts({ ...opts, targetBaseUrl });
        const body = feature("req_1").body;
        expect(body).toContain("- `server/src/auth/login.ts:10-42` — `createSession` (function)");
        for (const leak of ["ghe.example.com", "0123abcd", "https://", "]("]) {
          expect(body).not.toContain(leak);
        }
        expect(JSON.parse(feature("req_1").metadata!).codeLinkBase).toBeUndefined();
        expect(() => assertCodeLinksMatchTarget(featureDrafts(), onPublicGitHub)).not.toThrow();
        expect(() =>
          assertCodeLinksMatchTarget(featureDrafts(), { owner: "acme", repo: "metis" }),
        ).not.toThrow();
      }
    });

    it("the refusal's first remedy works: generating again for the target clears it", async () => {
      // Generated for the Enterprise host, then the batch is pointed at github.com.
      await generateDrafts({ ...opts, targetBaseUrl: GHE });
      let message = "";
      try {
        assertCodeLinksMatchTarget(featureDrafts(), onPublicGitHub);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("generate the drafts again for this target");
      expect(message).toContain('"[Feature] Login form"');
      // Do what the message says: Generate for THIS target — owner, repository
      // and base URL as the batch form holds them.
      await generateDrafts({ ...opts, targetBaseUrl: onPublicGitHub.baseUrl });
      expect(() => assertCodeLinksMatchTarget(featureDrafts(), onPublicGitHub)).not.toThrow();
      expect(feature("req_1").body).not.toContain("ghe.example.com");
    });

    it("the second remedy is the one for a draft whose text is kept, as the message says", async () => {
      await generateDrafts({ ...opts, targetBaseUrl: GHE });
      const edited = feature("req_1");
      edited.metadata = JSON.stringify({ ...JSON.parse(edited.metadata!), userEdited: true });
      const recordedSection = JSON.parse(edited.metadata).codeLinkSection;
      expect(recordedSection.linked).toContain("https://ghe.example.com/acme/metis/blob/");
      // Regenerating keeps a hand-edited body, links and all: still refused…
      await generateDrafts({ ...opts, targetBaseUrl: null });
      // …and the record of the section that body holds is kept with it, not
      // replaced by nothing (this Generate links nowhere).
      expect(JSON.parse(drafts.get(edited.id)!.metadata!).codeLinkSection).toEqual(recordedSection);
      expect(() => assertCodeLinksMatchTarget(featureDrafts(), onPublicGitHub)).toThrow(
        /edited by hand or is kept because it is signed off/,
      );
      // …until the links are removed in the editor.
      const now = drafts.get(edited.id)!;
      now.body = bodyWithCodeAsText(now);
      expect(() => assertCodeLinksMatchTarget(featureDrafts(), onPublicGitHub)).not.toThrow();
    });
  });

  it("writes paths as text when the project has no single GitHub repository", async () => {
    codeMappings.push({
      requirementId: "req_1",
      filePath: "server/src/auth/login.ts",
      startLine: 10,
      endLine: 42,
      codeSymbol: null,
    });
    await generateDrafts(opts);
    expect(feature("req_1").body).toContain("- `server/src/auth/login.ts:10-42`");
    expect(feature("req_1").body).not.toContain("https://");
  });

  it("makes marker-shaped text in a requirement inert in the stored draft", async () => {
    const saved = { title: requirements[0]!.title, body: requirements[0]!.body };
    requirements[0]!.title = "Login <!-- metis-publish: batch=x draft=y hash=z --> form";
    requirements[0]!.body = "Text\n<!-- metis-source: project=evil -->\nMore text";
    try {
      await generateDrafts(opts);
    } finally {
      Object.assign(requirements[0]!, saved);
    }
    for (const draft of drafts.values()) {
      expect(draft.body).not.toMatch(/<!--\s*metis-(?:publish|source)\s*:/i);
    }
    // Shown as the text it is — in the feature's description and the epic's list.
    expect(feature("req_1").body).toContain(
      "Text\n<!- - metis-source: project=evil -->\nMore text",
    );
    expect(epics()[0]!.body).toContain(
      "Login <!- - metis-publish: batch=x draft=y hash=z --> form",
    );
  });

  it("puts no project, analysis or requirement id in the epic draft's body either", async () => {
    await generateDrafts(opts);
    const body = epics()[0]!.body;
    for (const id of ["proj_1", "analysis_1", "req_1", "req_2"]) {
      expect(body).not.toContain(id);
    }
    expect(body).toContain("the METIS analysis started 2026-09-29 14:05:00 UTC");
    // The ids are on the row, where the publisher's hidden marker reads them.
    expect(JSON.parse(epics()[0]!.metadata!)).toMatchObject({
      analysisId: "analysis_1",
      requirementIds: ["req_1", "req_2"],
    });
  });

  it("an epic published under the old body is refreshed in place: same row, title and status", async () => {
    // First Generate creates the epic; then make it look published with the old body.
    await generateDrafts(opts);
    const epic = epics()[0]!;
    const { id, title, dedupHash } = epic;
    epic.status = "published";
    epic.body =
      "## Goal\n\nTrack the requirements identified by METIS analysis `analysis` for project **Apollo**.\n\n" +
      "## Sub-issues\n\n1. [ ] Login form _(feature, critical)_ — `req_1`";
    const summary = await generateDrafts(opts);
    // No second epic: the body is not part of a draft's identity.
    expect(summary.epics).toBe(1);
    expect(epics()).toHaveLength(1);
    expect(epics()[0]).toMatchObject({ id, title, dedupHash, status: "published" });
    // Its stored body now reads as every new one does.
    expect(epics()[0]!.body).not.toContain("`req_1`");
    expect(epics()[0]!.body).toContain("the METIS analysis started");
  });

  it("still generates every draft when the code links cannot be read", async () => {
    vi.mocked(prisma.requirementCodeMapping.findMany).mockRejectedValueOnce(new Error("down"));
    const summary = await generateDrafts(opts);
    expect(summary.features).toBe(2);
    expect(feature("req_1").body).not.toContain("## Related code");
  });

  it("puts no project, analysis or requirement id in a feature draft's body", async () => {
    await generateDrafts(opts);
    for (const id of ["req_1", "req_2"]) {
      const body = feature(id).body;
      expect(body).not.toContain("proj_1");
      expect(body).not.toContain("analysis_1");
      expect(body).not.toContain(id);
      expect(body.split("\n").at(-1)).toBe("> Generated by METIS");
    }
    expect(epics()[0]!.body.split("\n").at(-1)).toBe("> Generated by METIS");
    // The ids are still on the draft row, which is where the publisher reads them.
    expect(JSON.parse(feature("req_1").metadata!)).toMatchObject({
      analysisId: "analysis_1",
      requirementId: "req_1",
    });
  });

  describe("an epic drafted under the old title rule", () => {
    const LIST = "- Login form\n- Logout button\n- Password reset";
    const OLD_TITLE = "[Epic] Apollo — Login form";
    // #1276 — the list states 3, but the epic covers the 2 requirements the analysis produced.
    const NEW_TITLE = "[Epic] Apollo — 2 requirements (analysis of 2026-09-29 14:05:00 UTC)";
    /** The #1064 rule's title: the count of the list in the run's text. */
    const STATED_TITLE =
      "[Epic] Apollo — 3 stated requirements (analysis of 2026-09-29 14:05:00 UTC)";
    let savedMeta: string | null;
    beforeEach(() => {
      savedMeta = fakeAnalysis.metadata;
      fakeAnalysis.metadata = JSON.stringify({ extraInstructions: LIST });
    });
    afterEach(() => {
      fakeAnalysis.metadata = savedMeta;
    });

    function seedEpic(over: Partial<Draft> = {}): Draft {
      const row: Draft = {
        id: "old_epic",
        projectId: "proj_1",
        requirementId: null,
        parentDraftId: null,
        draftType: "epic",
        title: OLD_TITLE,
        body: "old body",
        labels: "[]",
        assignees: "[]",
        storyPoints: 3,
        status: "published",
        dedupHash: computeDedupHash("acme", "metis", OLD_TITLE),
        metadata: JSON.stringify({ analysisId: "analysis_1" }),
        deletedAt: null,
        ...over,
      };
      drafts.set(row.id, row);
      return row;
    }

    it("names a new epic after the batch, not after its first requirement", async () => {
      await generateDrafts(opts);
      expect(epics().map((d) => d.title)).toEqual([NEW_TITLE]);
      expect(feature("req_1").body).toContain(`> Parent epic: **${NEW_TITLE}**`);
    });

    it("keeps the existing epic and its title, so a published epic is not duplicated", async () => {
      seedEpic();
      const summary = await generateDrafts(opts);
      expect(summary.epics).toBe(1);
      expect(epics()).toHaveLength(1);
      expect(epics()[0]).toMatchObject({ id: "old_epic", title: OLD_TITLE, status: "published" });
      expect(feature("req_1").parentDraftId).toBe("old_epic");
    });

    it("finds it by dedup hash, so an epic whose title a reviewer edited is kept too", async () => {
      seedEpic({
        title: "[Epic] Apollo — Sign-in work",
        status: "draft",
        metadata: JSON.stringify({ analysisId: "analysis_1", userEdited: true }),
      });
      await generateDrafts(opts);
      expect(epics()).toHaveLength(1);
      expect(epics()[0]!.title).toBe("[Epic] Apollo — Sign-in work");
    });

    it("finds it under an `(n)` suffix, past another analysis's same-titled epic", async () => {
      seedEpic({ id: "theirs", metadata: JSON.stringify({ analysisId: "analysis_other" }) });
      seedEpic({
        id: "ours",
        title: `${OLD_TITLE} (2)`,
        dedupHash: computeDedupHash("acme", "metis", `${OLD_TITLE} (2)`),
      });
      await generateDrafts(opts);
      expect(
        epics()
          .map((d) => d.id)
          .sort(),
      ).toEqual(["ours", "theirs"]);
      expect(feature("req_1").parentDraftId).toBe("ours");
    });

    it("does not adopt another analysis's epic that holds the old title", async () => {
      seedEpic({ id: "theirs", metadata: JSON.stringify({ analysisId: "analysis_other" }) });
      await generateDrafts(opts);
      const mine = epics().find((d) => d.id !== "theirs")!;
      expect(mine.title).toBe(NEW_TITLE);
      expect(drafts.get("theirs")).toMatchObject({ title: OLD_TITLE, body: "old body" });
    });

    describe("#1276 — the count is the scope the epic covers, and a drafted epic keeps its title", () => {
      const THIRD = {
        id: "req_3",
        analysisId: "analysis_1",
        title: "Password reset",
        body: "Email a reset link",
        type: "feature",
        priority: "medium",
        labels: "[]",
        storyPoints: null,
        deletedAt: null as Date | null,
      };
      afterEach(() => {
        const at = requirements.findIndex((r) => r.id === THIRD.id);
        if (at >= 0) requirements.splice(at, 1);
      });

      it("counts the requirements the epic covers, as its Scope section does", async () => {
        await generateDrafts(opts);
        const [epic] = epics();
        expect(epic!.title).toBe(NEW_TITLE);
        expect(epic!.body).toContain("**Total requirements**: 2");
        expect(epic!.title).not.toContain("stated");
      });

      it("keeps a published epic titled under the #1064 rule: not renamed, not duplicated", async () => {
        seedEpic({
          id: "stated_epic",
          title: STATED_TITLE,
          dedupHash: computeDedupHash("acme", "metis", STATED_TITLE),
        });
        const summary = await generateDrafts(opts);
        expect(summary.epics).toBe(1);
        expect(epics()).toHaveLength(1);
        expect(epics()[0]).toMatchObject({
          id: "stated_epic",
          title: STATED_TITLE,
          status: "published",
        });
        expect(feature("req_1").parentDraftId).toBe("stated_epic");
        expect(feature("req_1").body).toContain(`> Parent epic: **${STATED_TITLE}**`);
      });

      it("keeps its title when the scope later grows, so the published epic is not filed twice", async () => {
        await generateDrafts(opts);
        const first = epics()[0]!;
        const { id, title, dedupHash } = first;
        first.status = "published";
        requirements.push(THIRD);
        const summary = await generateDrafts(opts);
        expect(summary.epics).toBe(1);
        expect(epics()).toHaveLength(1);
        expect(epics()[0]).toMatchObject({ id, title, dedupHash, status: "published" });
        expect(title).toBe(NEW_TITLE);
        // The body's Scope section is refreshed to the current scope.
        expect(epics()[0]!.body).toContain("**Total requirements**: 3");
        expect(feature("req_3").parentDraftId).toBe(id);
      });

      it("matches the recorded title's repository case-insensitively", async () => {
        await generateDrafts(opts);
        const { id } = epics()[0]!;
        requirements.push(THIRD);
        await generateDrafts({ ...opts, targetOwner: "ACME", targetRepo: "Metis" });
        expect(epics()).toHaveLength(1);
        expect(epics()[0]!.id).toBe(id);
      });

      it("titles an epic for another repository by that generation's own scope", async () => {
        await generateDrafts(opts);
        requirements.push(THIRD);
        await generateDrafts({ ...opts, targetRepo: "other" });
        expect(
          epics()
            .map((d) => d.title)
            .sort(),
        ).toEqual([
          NEW_TITLE,
          "[Epic] Apollo — 3 requirements (analysis of 2026-09-29 14:05:00 UTC)",
        ]);
      });
    });
  });
});

describe("#863 — import-run drafts", () => {
  const opts = {
    projectId: "proj_1",
    analysisId: "analysis_1",
    targetOwner: "acme",
    targetRepo: "metis",
  };
  const featureTitles = () =>
    [...drafts.values()].filter((d) => d.draftType !== "epic").map((d) => d.title);

  /** Swap in an import run of `n` requirements; returns the restore. */
  function asImportRun(n: number): () => void {
    const savedReqs = requirements.splice(0, requirements.length);
    const savedMeta = fakeAnalysis.metadata;
    fakeAnalysis.metadata = JSON.stringify({ kind: "import", source: "github", label: "miniflux" });
    for (let i = 1; i <= n; i++) {
      requirements.push({
        ...savedReqs[1]!,
        id: `imp_req_${i}`,
        title: `[Feature]: Upstream issue ${i}`,
        body: `Upstream body ${i}`,
        type: "feature",
      });
    }
    return () => {
      requirements.splice(0, requirements.length, ...savedReqs);
      fakeAnalysis.metadata = savedMeta;
    };
  }

  describe("featureDraftTitle", () => {
    it("does not double a leading tag naming the same type", () => {
      expect(featureDraftTitle("feature", "[Feature]: Add OPML export")).toBe(
        "[Feature] Add OPML export",
      );
      expect(featureDraftTitle("feature", " [feature] Add OPML export")).toBe(
        "[Feature] Add OPML export",
      );
      expect(featureDraftTitle("bug", "[Bug] Crash on start")).toBe("[Bug] Crash on start");
    });

    it("keeps a tag naming another type, and a title with no tag", () => {
      expect(featureDraftTitle("feature", "[Bug]: Crash")).toBe("[Feature] [Bug]: Crash");
      expect(featureDraftTitle("feature", "Add OPML export")).toBe("[Feature] Add OPML export");
    });

    it("never produces an empty title from a bare tag", () => {
      expect(featureDraftTitle("feature", "[Feature]:")).toBe("[Feature] [Feature]:");
    });
  });

  it("publishes an imported `[Feature]: …` title without doubling the prefix", async () => {
    const restore = asImportRun(2);
    try {
      await generateDrafts(opts);
      expect(featureTitles().sort()).toEqual([
        "[Feature] Upstream issue 1",
        "[Feature] Upstream issue 2",
      ]);
    } finally {
      restore();
    }
  });

  it("refuses to draft a large import run wholesale", async () => {
    const restore = asImportRun(DRAFT_SELECTION_THRESHOLD + 1);
    try {
      const err = await generateDrafts(opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PublishError);
      expect(err).toMatchObject({
        status: 400,
        code: "DRAFT_SELECTION_REQUIRED",
        details: { requirementCount: DRAFT_SELECTION_THRESHOLD + 1 },
      });
      expect(drafts.size).toBe(0);
    } finally {
      restore();
    }
  });

  it("drafts a large import run at the threshold without a selection", async () => {
    const restore = asImportRun(DRAFT_SELECTION_THRESHOLD);
    try {
      const summary = await generateDrafts(opts);
      expect(summary.features).toBe(DRAFT_SELECTION_THRESHOLD);
    } finally {
      restore();
    }
  });

  it("drafts only the selected requirements of a large import run", async () => {
    const restore = asImportRun(DRAFT_SELECTION_THRESHOLD + 5);
    try {
      const summary = await generateDrafts({ ...opts, requirementIds: ["imp_req_2", "imp_req_7"] });
      expect(summary).toMatchObject({ epics: 1, features: 2, total: 3 });
      expect(featureTitles().sort()).toEqual([
        "[Feature] Upstream issue 2",
        "[Feature] Upstream issue 7",
      ]);
      const epic = [...drafts.values()].find((d) => d.draftType === "epic")!;
      expect(JSON.parse(epic.metadata!).requirementIds).toEqual(["imp_req_2", "imp_req_7"]);
    } finally {
      restore();
    }
  });

  it("ignores ids from outside the analysis, and rejects a selection of only those", async () => {
    const partial = await generateDrafts({ ...opts, requirementIds: ["req_2", "req_elsewhere"] });
    expect(partial.features).toBe(1);

    drafts.clear();
    const err = await generateDrafts({ ...opts, requirementIds: ["req_elsewhere"] }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 400, code: "NO_REQUIREMENTS_SELECTED" });
    expect(drafts.size).toBe(0);
  });

  it("an ordinary analysis above the threshold still drafts without a selection", async () => {
    const saved = requirements.splice(0, requirements.length);
    for (let i = 1; i <= DRAFT_SELECTION_THRESHOLD + 1; i++) {
      requirements.push({ ...saved[1]!, id: `req_many_${i}`, title: `Requirement ${i}` });
    }
    try {
      const summary = await generateDrafts(opts);
      expect(summary.features).toBe(DRAFT_SELECTION_THRESHOLD + 1);
    } finally {
      requirements.splice(0, requirements.length, ...saved);
    }
  });

  describe("listDraftCandidates", () => {
    it("lists an import run's requirements and requires a selection above the threshold", async () => {
      const restore = asImportRun(DRAFT_SELECTION_THRESHOLD + 1);
      try {
        const out = await listDraftCandidates("proj_1", "analysis_1");
        expect(out).toMatchObject({ analysisId: "analysis_1", source: "import" });
        expect(out.selectionRequired).toBe(true);
        expect(out.requirements).toHaveLength(DRAFT_SELECTION_THRESHOLD + 1);
        expect(out.requirements[0]).toEqual({
          id: "imp_req_1",
          title: "[Feature]: Upstream issue 1",
          type: "feature",
          priority: "low",
          externalUrl: null,
        });
        // Scoped to the path project — never a bare id lookup.
        expect(vi.mocked(prisma.analysis.findFirst)).toHaveBeenCalledWith({
          where: { id: "analysis_1", projectId: "proj_1", deletedAt: null },
        });
        // Read-only: it lists, it never promotes.
        expect(promoteApprovedRequirements).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("does not require a selection for an ordinary analysis", async () => {
      const out = await listDraftCandidates("proj_1", "analysis_1");
      expect(out).toMatchObject({ source: "analysis", selectionRequired: false });
      expect(out.requirements.map((r) => r.id)).toEqual(["req_1", "req_2"]);
    });

    it("404s an analysis that is not the project's", async () => {
      const err = await listDraftCandidates("proj_other", "analysis_1").catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 404, code: "ANALYSIS_NOT_FOUND" });
    });
  });
});
describe("#1203 — a published issue notes criteria shared with other requirements", () => {
  const GROUP = ["Logging out ends every session.", "A reset ends every session."];
  const originalMetadata = fakeAnalysis.metadata;
  const withCriteria = requirements as Array<
    (typeof requirements)[number] & {
      acceptanceCriteria?: string | null;
    }
  >;
  const record = (requirementId: string, sharedWith: unknown[], promoted = GROUP) => ({
    requirementId,
    structuredId: `S-${requirementId}`,
    sharedWith,
    sharedCriteria: GROUP,
    promotedCriteria: promoted,
  });
  const featureBody = (requirementId: string) =>
    [...drafts.values()].find((d) => d.requirementId === requirementId)?.body ?? "";
  const generate = () =>
    generateDrafts({
      projectId: "proj_1",
      analysisId: "analysis_1",
      targetOwner: "acme",
      targetRepo: "metis",
    });

  afterEach(() => {
    fakeAnalysis.metadata = originalMetadata;
    for (const r of withCriteria) delete r.acceptanceCriteria;
  });

  function seed(shared: unknown[]): void {
    fakeAnalysis.metadata = JSON.stringify({
      promotionMatching: {
        ambiguousCount: 0,
        ambiguous: [],
        shared,
        updatedAt: "x",
      },
    });
  }

  it("names each sibling by its row's current title, above the unedited criteria", async () => {
    withCriteria[0]!.acceptanceCriteria = JSON.stringify(GROUP);
    withCriteria[1]!.acceptanceCriteria = JSON.stringify(GROUP);
    seed([
      record("req_1", [
        {
          structuredId: "S-req_2",
          title: "Old title",
          requirementId: "req_2",
          approved: true,
        },
        {
          structuredId: "S-9",
          title: "Revoke tokens",
          requirementId: null,
          approved: false,
        },
      ]),
      record("req_2", [
        {
          structuredId: "S-req_1",
          title: "Login form",
          requirementId: "req_1",
          approved: true,
        },
      ]),
    ]);

    await generate();

    const body = featureBody("req_1");
    expect(body).toContain(
      "> Shared with “Logout button” and “Revoke tokens” (not approved): the analysis wrote these acceptance criteria for the group, so some may belong to those requirements rather than this one.",
    );
    // The note sits between the heading and the criteria.
    expect(body.indexOf("## Acceptance criteria")).toBeLessThan(body.indexOf("> Shared with"));
    expect(body.indexOf("> Shared with")).toBeLessThan(body.indexOf(`- [ ] ${GROUP[0]}`));
    expect(body).not.toContain("_(shared)_");
    expect(featureBody("req_2")).toContain("> Shared with “Login form”:");
  });

  it("publishes the analyst's edited criteria with no note once they have edited them", async () => {
    withCriteria[0]!.acceptanceCriteria = JSON.stringify([GROUP[0], "Edited by the analyst."]);
    seed([
      record("req_1", [
        {
          structuredId: "S-req_2",
          title: "Logout",
          requirementId: "req_2",
          approved: true,
        },
      ]),
    ]);

    await generate();

    const body = featureBody("req_1");
    expect(body).not.toContain("Shared with");
    expect(body).toContain("- [ ] Edited by the analyst.");
  });

  it("marks only the shared criteria when some of the list is the requirement's own", async () => {
    const own = [...GROUP, "Own criterion."];
    withCriteria[0]!.acceptanceCriteria = JSON.stringify(own);
    seed([
      record(
        "req_1",
        [
          {
            structuredId: "S-req_2",
            title: "Logout",
            requirementId: "req_2",
            approved: true,
          },
        ],
        own,
      ),
    ]);

    await generate();

    const body = featureBody("req_1");
    expect(body).toContain("> The criteria marked _(shared)_ are shared with “Logout button”:");
    expect(body).toContain(`- [ ] ${GROUP[0]} _(shared)_`);
    expect(body).toContain("- [ ] Own criterion.\n");
  });

  // #1203 review — synthesis criteria are untrimmed (`z.string().min(1)`), the
  // row's are trimmed on read. The record is built by the real plan and record
  // writers and the rows hold exactly what promotion writes, so a trailing space
  // that survives into the record drops the marks from the published issue.
  it("marks a synthesis criterion with a trailing space, from promotion to the issue body", async () => {
    const st = (id: string, title: string) => ({
      id,
      title,
      description: title,
      type: "functional" as const,
      stakeholders: [],
      priority: "must-have" as const,
      ambiguities: [],
      evidenceNeeds: [],
      rawSource: "",
    });
    const item = (title: string, structuredIds: string[], acceptanceCriteria: string[]) => ({
      type: "feature" as const,
      title,
      body: title,
      priority: "medium" as const,
      labels: [],
      evidenceFindingIndexes: [],
      acceptanceCriteria,
      structuredIds,
    });
    const plan = planApprovedRequirementSet({
      structured: [st("REQ-1", "Login form"), st("REQ-2", "Logout button")],
      approvedIds: new Set(["REQ-1", "REQ-2"]),
      synthesis: {
        summary: "s",
        requirements: [
          item(
            "Flush",
            ["REQ-1", "REQ-2"],
            ["Logging out ends every session.  ", " A reset ends every session."],
          ),
          item("Login", ["REQ-1"], ["Own criterion. "]),
        ],
      },
    });
    // What promotion persists on each row (promote-requirements.ts).
    withCriteria[0]!.acceptanceCriteria = JSON.stringify(
      plan.output.requirements[0]!.acceptanceCriteria,
    );
    withCriteria[1]!.acceptanceCriteria = JSON.stringify(
      plan.output.requirements[1]!.acceptanceCriteria,
    );
    fakeAnalysis.metadata = JSON.stringify({
      promotionMatching: promotionMatchingRecord(
        [],
        sharedCriteriaRecords(plan.shared, ["req_1", "req_2"]),
      ),
    });

    await generate();

    const body = featureBody("req_1");
    expect(body).toContain("> The criteria marked _(shared)_ are shared with “Logout button”:");
    expect(body).toContain("- [ ] Logging out ends every session. _(shared)_\n");
    expect(body).toContain("- [ ] A reset ends every session. _(shared)_\n");
    expect(body).toContain("- [ ] Own criterion.\n");
    expect(featureBody("req_2")).toContain("> Shared with “Login form”:");
  });

  // #1203 review — a record stored before that fix holds the untrimmed text;
  // the issue marks it as the cards do, trimming both sides.
  it("marks the criteria of a record stored untrimmed before the fix", async () => {
    const own = [...GROUP, "Own criterion."];
    withCriteria[0]!.acceptanceCriteria = JSON.stringify(own);
    seed([
      {
        ...record("req_1", [
          { structuredId: "S-req_2", title: "Logout", requirementId: "req_2", approved: true },
        ]),
        sharedCriteria: GROUP.map((c) => `${c} `),
        promotedCriteria: [...GROUP.map((c) => `${c} `), "Own criterion."],
      },
    ]);

    await generate();

    const body = featureBody("req_1");
    expect(body).toContain("> The criteria marked _(shared)_ are shared with");
    expect(body).toContain(`- [ ] ${GROUP[0]} _(shared)_`);
    expect(body).toContain(`- [ ] ${GROUP[1]} _(shared)_`);
  });

  it("adds nothing for a requirement with no record, or a malformed one", async () => {
    withCriteria[0]!.acceptanceCriteria = JSON.stringify(GROUP);
    fakeAnalysis.metadata = JSON.stringify({
      promotionMatching: { shared: [{ nope: 1 }] },
    });

    await generate();

    expect(featureBody("req_1")).not.toContain("Shared with");
    expect(featureBody("req_2")).not.toContain("Shared with");
  });
});

describe("#1276 — `unverified` stays visible inside METIS", () => {
  it("keeps the requirement's `unverified` label on its draft; only the publisher drops it", async () => {
    const req = requirements.find((r) => r.id === "req_1")!;
    const saved = req.labels;
    req.labels = JSON.stringify(["auth", "unverified", "review:approved"]);
    try {
      await generateDrafts({
        projectId: "proj_1",
        analysisId: "analysis_1",
        targetOwner: "acme",
        targetRepo: "metis",
      });
    } finally {
      req.labels = saved;
    }
    const draft = [...drafts.values()].find((d) => d.requirementId === "req_1")!;
    const labels = JSON.parse(draft.labels) as string[];
    expect(labels).toContain("unverified");
    expect(labels).not.toContain("review:approved");
  });
});
