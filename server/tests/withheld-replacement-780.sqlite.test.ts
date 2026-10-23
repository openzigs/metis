/**
 * #780 — a withheld re-synthesis has a path forward: the analyst compares it
 * with the current set and applies or dismisses it.
 *
 * #769 refuses to replace a requirement set that carries review work, and
 * before #780 threw the refused result away. Proven here over a REAL migrated
 * SQLite database (real cascades) through the real project-scoped analysis
 * router: the refused rows are stored, the comparison names what applying does
 * to each requirement, applying never deletes review work (a reviewed
 * requirement is updated through version history or kept; a deleted one is not
 * restored), dismissing writes no requirement, and both are scoped, permission
 * gated, audited and refuse a stale answer.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SynthesisDegradation, SynthesisOutput, WithheldReplacementDiff } from "@metis/shared";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));
const auditSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: auditSpy,
}));

const { persistRequirements, getAnalysisSnapshot } =
  await import("../src/lib/analysis/analysis-service.js");
const { APPLIED_WITHHELD_REPLACEMENT_REASON, WITHHELD_PROPOSAL_KEY } =
  await import("../src/lib/analysis/withheld-replacement.js");
const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { updateRequirementWithHistory } =
  await import("../src/lib/requirements/requirement-version-service.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-780";
const OTHER_WS = "ws-780-x";
const PROJECT = "p-780";
const OTHER_PROJECT = "p-780-x";
/** A project the analyst CAN reach, so only the analysis↔project check refuses it. */
const SIBLING_PROJECT = "p-780-sibling";
const LIMITED_A = "u-780-limited-a";
const LIMITED_B = "u-780-limited-b";
const ANALYST = "u-780";
const READER = "u-780-reader";
const ANALYSIS = "an-780";

const DEGRADED: SynthesisDegradation = {
  reason: "non-json",
  attempts: 2,
  requirementCount: 2,
  at: "2026-10-23T00:00:00.000Z",
};

interface Item {
  title: string;
  body?: string;
  criteria?: string[];
  priority?: "low" | "medium" | "high";
}

function synthesis(items: Item[]): SynthesisOutput {
  return {
    summary: "s",
    requirements: items.map((i) => ({
      type: "feature" as const,
      title: i.title,
      body: i.body ?? `${i.title} body`,
      priority: i.priority ?? "medium",
      labels: [],
      evidenceFindingIndexes: [],
      acceptanceCriteria: i.criteria ?? [],
    })),
  };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#780 — review, apply or dismiss a withheld re-synthesis (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ANALYST_TOKEN = "";
    let READER_TOKEN = "";
    let LIMITED_A_TOKEN = "";
    let LIMITED_B_TOKEN = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const base = (project = PROJECT) => `/api/projects/${project}/analyses/${ANALYSIS}`;
    const getDiff = (project = PROJECT, token = ANALYST_TOKEN) =>
      request(app())
        .get(`${base(project)}/withheld-replacement`)
        .set("Authorization", `Bearer ${token}`);
    const answer = (
      choice: string,
      body: Record<string, unknown>,
      project = PROJECT,
      token = ANALYST_TOKEN,
    ) =>
      request(app())
        .post(`${base(project)}/withheld-replacement/${choice}`)
        .set("Authorization", `Bearer ${token}`)
        .send(body);
    /** Review, then apply what the review showed: the UI's sequence. */
    const apply = async (at: string) => {
      const diff = await getDiff();
      return answer("apply", { at, fingerprint: diff.body.data?.fingerprint ?? "none" });
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("780-withheld-replacement");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: "ws", slug: WS } });
      for (const id of [ANALYST, READER, LIMITED_A, LIMITED_B]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.workspaceMember.create({ data: { workspaceId: WS, userId: id, role: "member" } });
      }
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: ANALYST, workspaceId: WS },
      });
      await db.project.create({
        data: {
          id: SIBLING_PROJECT,
          name: SIBLING_PROJECT,
          slug: SIBLING_PROJECT,
          createdById: ANALYST,
          workspaceId: WS,
        },
      });
      await db.workspace.create({ data: { id: OTHER_WS, name: "x", slug: OTHER_WS } });
      await db.project.create({
        data: {
          id: OTHER_PROJECT,
          name: OTHER_PROJECT,
          slug: OTHER_PROJECT,
          createdById: ANALYST,
          workspaceId: OTHER_WS,
        },
      });
      const token = (userId: string, role: "coordinator" | "reader") =>
        issueTokens({ userId, username: userId, role, permissions: [], workspaces: [WS] })
          .accessToken;
      ANALYST_TOKEN = token(ANALYST, "coordinator");
      READER_TOKEN = token(READER, "reader");
      LIMITED_A_TOKEN = token(LIMITED_A, "coordinator");
      LIMITED_B_TOKEN = token(LIMITED_B, "coordinator");
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      state.db = db;
      auditSpy.mockClear();
      await db.analysis.deleteMany({});
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: ANALYST, status: "completed" },
      });
    });

    const persist = (items: Item[], degraded: SynthesisDegradation | null = null) =>
      persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(items),
        findingIdsByIndex: [],
        degraded,
      });

    async function metadata(): Promise<Record<string, unknown>> {
      const row = await db.analysis.findUniqueOrThrow({ where: { id: ANALYSIS } });
      return row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
    }

    async function byTitle(title: string) {
      return db.requirement.findFirst({ where: { analysisId: ANALYSIS, title } });
    }

    /**
     * The walkthrough shape: Approved (approved, linked to Plain), Plain (no
     * review work), Dropped (no review work, left out of the re-synthesis),
     * Commented (review work, left out), Removed (someone deleted it). The
     * re-synthesis rewrites Approved, restates Plain unchanged, restates
     * Removed and adds New.
     */
    async function seedWithheld(): Promise<{ at: string; approvedId: string; linkId: string }> {
      await persist([
        { title: "Approved", criteria: ["Old check."] },
        { title: "Plain" },
        { title: "Dropped" },
        { title: "Commented" },
        { title: "Removed" },
      ]);
      const approved = (await byTitle("Approved"))!;
      const plain = (await byTitle("Plain"))!;
      await db.requirement.update({
        where: { id: approved.id },
        data: { reviewStatus: "approved" },
      });
      const link = await db.requirementLink.create({
        data: {
          sourceRequirementId: approved.id,
          targetRequirementId: plain.id,
          type: "depends_on",
          createdById: ANALYST,
        },
      });
      await db.requirement.update({
        where: { id: (await byTitle("Commented"))!.id },
        data: { reviewStatus: "deferred" },
      });
      await db.requirement.update({
        where: { id: (await byTitle("Removed"))!.id },
        data: { deletedAt: new Date() },
      });
      let withheldAt = "";
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis([
          { title: "Approved", body: "Approved, reworded.", criteria: ["New check."] },
          { title: "Plain" },
          { title: "Removed" },
          { title: "New", priority: "high", criteria: ["It works."] },
        ]),
        findingIdsByIndex: [],
        degraded: null,
        onWithheld: (w) => {
          withheldAt = w.at;
        },
      });
      return { at: withheldAt, approvedId: approved.id, linkId: link.id };
    }

    it("stores the withheld result with the refusal, and keeps it out of the snapshot", async () => {
      await seedWithheld();
      const meta = await metadata();
      expect(meta.requirementReplacementWithheld).toMatchObject({
        reason: "reviewed-work",
        proposedCount: 4,
        proposalStored: true,
      });
      const proposal = meta[WITHHELD_PROPOSAL_KEY] as { rows: Array<{ title: string }> };
      expect(proposal.rows.map((r) => r.title)).toEqual(["Approved", "Plain", "Removed", "New"]);
      const snapshot = await getAnalysisSnapshot(ANALYSIS);
      expect(snapshot!.metadata).not.toHaveProperty(WITHHELD_PROPOSAL_KEY);
      expect(snapshot!.metadata).toHaveProperty("requirementReplacementWithheld");
    });

    it("the comparison says what applying does to each requirement, by title", async () => {
      await seedWithheld();
      const res = await getDiff();
      expect(res.status).toBe(200);
      const diff = res.body.data as WithheldReplacementDiff;
      expect(diff.added.map((e) => [e.title, e.outcome])).toEqual([["New", "add"]]);
      expect(diff.added[0]!.proposed).toMatchObject({
        priority: "high",
        acceptanceCriteria: ["It works."],
      });
      expect(diff.changed).toHaveLength(1);
      expect(diff.changed[0]).toMatchObject({
        title: "Approved",
        outcome: "update",
        reviewed: true,
        reviewStatus: "approved",
      });
      expect(diff.changed[0]!.changes).toEqual([
        { field: "description", before: "Approved body", after: "Approved, reworded." },
        { field: "acceptanceCriteria", before: ["Old check."], after: ["New check."] },
      ]);
      expect(diff.removed.map((e) => [e.title, e.outcome])).toEqual([
        ["Dropped", "delete"],
        ["Commented", "keep"],
      ]);
      expect(diff.skipped.map((e) => [e.title, e.outcome])).toEqual([["Removed", "skip"]]);
      expect(diff.unchangedCount).toBe(1);
      // A reader may look.
      expect((await getDiff(PROJECT, READER_TOKEN)).status).toBe(200);
    });

    it("apply: never deletes review work — the reviewed one is updated through history, the rest as a re-run", async () => {
      const { at, approvedId, linkId } = await seedWithheld();
      const res = await apply(at);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ added: 1, replaced: 0, updated: 1, deleted: 1, kept: 1 });

      // Same row: status, link and history kept; new content as the analyst's version.
      const approved = await db.requirement.findUniqueOrThrow({ where: { id: approvedId } });
      expect(approved.reviewStatus).toBe("approved");
      expect(approved.body).toBe("Approved, reworded.");
      expect(JSON.parse(approved.acceptanceCriteria)).toEqual(["New check."]);
      expect(await db.requirementLink.count({ where: { id: linkId } })).toBe(1);
      const versions = await db.requirementVersion.findMany({
        where: { requirementId: approvedId },
      });
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        actorId: ANALYST,
        reason: APPLIED_WITHHELD_REPLACEMENT_REASON,
      });

      expect(await byTitle("Dropped")).toBeNull();
      expect((await byTitle("Commented"))!.reviewStatus).toBe("deferred");
      expect(await byTitle("New")).not.toBeNull();
      expect(await byTitle("Plain")).not.toBeNull();
      // The deleted requirement stays deleted and is not restored as a new row.
      const removed = await db.requirement.findMany({
        where: { analysisId: ANALYSIS, title: "Removed" },
      });
      expect(removed).toHaveLength(1);
      expect(removed[0]!.deletedAt).not.toBeNull();

      const meta = await metadata();
      expect(meta.requirementReplacementWithheld).toBeUndefined();
      expect(meta[WITHHELD_PROPOSAL_KEY]).toBeUndefined();
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "analysis.replacement_withheld.apply",
          target: { type: "analysis", id: ANALYSIS },
          metadata: expect.objectContaining({ projectId: PROJECT, updated: 1, kept: 1 }),
        }),
      );
      // Answered: nothing left to review or apply.
      expect((await getDiff()).status).toBe(404);
      expect((await apply(at)).body.error.code).toBe("NO_PROPOSAL");
    });

    it("apply: a re-synthesis that gave no criteria leaves a reviewed requirement's criteria alone", async () => {
      await persist([{ title: "Approved", criteria: ["Keep me."] }]);
      const row = (await byTitle("Approved"))!;
      await db.requirement.update({ where: { id: row.id }, data: { reviewStatus: "approved" } });
      let at = "";
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis([{ title: "Approved", criteria: [] }]),
        findingIdsByIndex: [],
        onWithheld: (w) => {
          at = w.at;
        },
      });
      const diff = (await getDiff()).body.data as WithheldReplacementDiff;
      expect(diff.changed).toEqual([]);
      expect(diff.unchangedCount).toBe(1);
      expect((await apply(at)).body.data.updated).toBe(0);
      const after = await db.requirement.findUniqueOrThrow({ where: { id: row.id } });
      expect(JSON.parse(after.acceptanceCriteria)).toEqual(["Keep me."]);
      expect(await db.requirementVersion.count({ where: { requirementId: row.id } })).toBe(0);
    });

    it("dismiss: writes no requirement and clears the notice", async () => {
      const { at } = await seedWithheld();
      const before = await db.requirement.findMany({
        where: { analysisId: ANALYSIS },
        orderBy: { id: "asc" },
      });
      const res = await answer("dismiss", { at });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ discarded: 4 });
      const after = await db.requirement.findMany({
        where: { analysisId: ANALYSIS },
        orderBy: { id: "asc" },
      });
      expect(after).toEqual(before);
      const meta = await metadata();
      expect(meta.requirementReplacementWithheld).toBeUndefined();
      expect(meta[WITHHELD_PROPOSAL_KEY]).toBeUndefined();
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "analysis.replacement_withheld.dismiss",
          metadata: { projectId: PROJECT, at, discarded: 4 },
        }),
      );
      const again = await answer("dismiss", { at });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("NO_PROPOSAL");
    });

    it("refuses a stale answer, another project, a reader, a bad body and an unknown choice", async () => {
      const { at } = await seedWithheld();
      const stale = await answer("apply", { at: "2020-01-01T00:00:00.000Z", fingerprint: "x" });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe("STALE");
      expect((await answer("apply", { at, fingerprint: "x" }, OTHER_PROJECT)).status).toBe(404);
      expect((await getDiff(OTHER_PROJECT)).status).toBe(404);
      // A project the analyst can reach, but not this analysis's: only the
      // analysis↔project check refuses it, with the unknown-analysis 404.
      const sibling = await getDiff(SIBLING_PROJECT);
      expect(sibling.status).toBe(404);
      expect(sibling.body.error.code).toBe("ANALYSIS_NOT_FOUND");
      for (const choice of ["apply", "dismiss"]) {
        const res = await answer(choice, { at, fingerprint: "x" }, SIBLING_PROJECT);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
      }
      expect((await answer("apply", { at, fingerprint: "x" }, PROJECT, READER_TOKEN)).status).toBe(
        403,
      );
      expect((await answer("dismiss", { at }, PROJECT, READER_TOKEN)).status).toBe(403);
      expect((await answer("apply", {})).status).toBe(400);
      expect((await answer("apply", { at: 5 })).status).toBe(400);
      expect((await answer("apply", { at })).status).toBe(400);
      expect((await answer("replace-everything", { at })).status).toBe(404);
      // Nothing was answered.
      expect((await metadata())[WITHHELD_PROPOSAL_KEY]).toBeDefined();
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("a newer refusal supersedes the stored result; an allowed replacement clears it", async () => {
      const { at } = await seedWithheld();
      let newer = "";
      await new Promise((r) => setTimeout(r, 5));
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis([{ title: "Only" }]),
        findingIdsByIndex: [],
        onWithheld: (w) => {
          newer = w.at;
        },
      });
      expect(newer).not.toBe(at);
      expect((await apply(at)).body.error.code).toBe("STALE");
      const diff = (await getDiff()).body.data as WithheldReplacementDiff;
      expect(diff.added.map((e) => e.title)).toEqual(["Only"]);

      // Remove every trace of review work: the next re-synthesis replaces the set.
      await db.requirementLink.deleteMany({});
      await db.requirement.updateMany({ data: { reviewStatus: null } });
      await db.requirement.deleteMany({ where: { deletedAt: { not: null } } });
      await persist([{ title: "Fresh" }]);
      const meta = await metadata();
      expect(meta.requirementReplacementWithheld).toBeUndefined();
      expect(meta[WITHHELD_PROPOSAL_KEY]).toBeUndefined();
      expect((await getDiff()).status).toBe(404);
    });

    it("a refusal recorded before #780 kept nothing: no comparison to offer", async () => {
      await db.analysis.update({
        where: { id: ANALYSIS },
        data: {
          metadata: JSON.stringify({
            requirementReplacementWithheld: {
              reason: "reviewed-work",
              existingCount: 1,
              reviewedCount: 1,
              proposedCount: 2,
              at: "2026-10-01T00:00:00.000Z",
            },
          }),
        },
      });
      const res = await getDiff();
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NO_WITHHELD_REPLACEMENT");
      expect((await answer("dismiss", { at: "2026-10-01T00:00:00.000Z" })).status).toBe(409);
    });

    it("degraded over healthy: applying replaces the set and marks it degraded", async () => {
      await persist([{ title: "Healthy A" }, { title: "Healthy B" }]);
      let at = "";
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis([{ title: "Keyword cluster" }]),
        findingIdsByIndex: [],
        degraded: DEGRADED,
        onWithheld: (w) => {
          at = w.at;
        },
      });
      expect((await metadata()).requirementReplacementWithheld).toMatchObject({
        reason: "degraded-synthesis",
      });
      const res = await apply(at);
      expect(res.body.data).toEqual({ added: 1, replaced: 0, updated: 0, deleted: 2, kept: 0 });
      const titles = (
        await db.requirement.findMany({ where: { analysisId: ANALYSIS }, select: { title: true } })
      ).map((r) => r.title);
      expect(titles).toEqual(["Keyword cluster"]);
      expect((await metadata()).synthesisDegraded).toEqual(DEGRADED);
    });

    it("apply on an approved (checkpoint) set: inserted rows are approved and recorded as such", async () => {
      // A checkpoint-approved set whose re-synthesis is withheld by a person's
      // review work: the restatements inserted on apply are approved too.
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis([{ title: "Edited" }]),
        findingIdsByIndex: [],
        reviewStatus: "approved",
      });
      const edited = (await byTitle("Edited"))!;
      await db.requirement.update({ where: { id: edited.id }, data: { reviewStatus: "rejected" } });
      let at = "";
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis([{ title: "Edited" }, { title: "Added" }]),
        findingIdsByIndex: [],
        reviewStatus: "approved",
        onWithheld: (w) => {
          at = w.at;
        },
      });
      expect((await apply(at)).body.data.added).toBe(1);
      const added = (await byTitle("Added"))!;
      expect(added.reviewStatus).toBe("approved");
      const ids = (await metadata()).checkpointApprovedRequirementIds as string[];
      expect(ids).toContain(added.id);
      expect(ids).toContain(edited.id);
    });
    it("both routes are rate limited per user", async () => {
      const { at } = await seedWithheld();
      process.env.WITHHELD_REPLACEMENT_LIMIT_MAX = "1";
      try {
        // A spends its one request on GET: the POST is refused by the limiter.
        expect((await getDiff(PROJECT, LIMITED_A_TOKEN)).status).toBe(200);
        const postLimited = await answer("dismiss", { at }, PROJECT, LIMITED_A_TOKEN);
        expect(postLimited.status).toBe(429);
        expect(postLimited.body.error.code).toBe("WITHHELD_REPLACEMENT_RATE_LIMITED");
        // B spends its one on a refused POST: the GET is refused by the limiter.
        expect(
          (await answer("apply", { at: "stale", fingerprint: "x" }, PROJECT, LIMITED_B_TOKEN))
            .status,
        ).toBe(409);
        const getLimited = await getDiff(PROJECT, LIMITED_B_TOKEN);
        expect(getLimited.status).toBe(429);
        expect(getLimited.body.error.code).toBe("WITHHELD_REPLACEMENT_RATE_LIMITED");
      } finally {
        delete process.env.WITHHELD_REPLACEMENT_LIMIT_MAX;
      }
      expect((await metadata())[WITHHELD_PROPOSAL_KEY]).toBeDefined();
    });

    it("apply: an unreviewed requirement the re-synthesis gave no criteria keeps its criteria", async () => {
      await persist([
        { title: "Reviewed" },
        { title: "Unreviewed", body: "Old body", criteria: ["Keep me."] },
      ]);
      await db.requirement.update({
        where: { id: (await byTitle("Reviewed"))!.id },
        data: { reviewStatus: "approved" },
      });
      let at = "";
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis([
          { title: "Reviewed" },
          { title: "Unreviewed", body: "New body", criteria: [] },
        ]),
        findingIdsByIndex: [],
        onWithheld: (w) => {
          at = w.at;
        },
      });
      const diff = (await getDiff()).body.data as WithheldReplacementDiff;
      expect(diff.changed[0]!.changes.map((c) => c.field)).toEqual(["description"]);
      expect((await apply(at)).body.data.replaced).toBe(1);
      const row = (await byTitle("Unreviewed"))!;
      expect(row.body).toBe("New body");
      expect(JSON.parse(row.acceptanceCriteria)).toEqual(["Keep me."]);
    });

    it("apply: a proposal of unknown health leaves the degradation marker alone", async () => {
      await persist([{ title: "A" }]);
      const a = (await byTitle("A"))!;
      await db.requirement.update({ where: { id: a.id }, data: { reviewStatus: "approved" } });
      const meta = await metadata();
      await db.analysis.update({
        where: { id: ANALYSIS },
        data: { metadata: JSON.stringify({ ...meta, synthesisDegraded: DEGRADED }) },
      });
      let at = "";
      // No `degraded`: the #1104 promotion path does not know the health.
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis([{ title: "B" }]),
        findingIdsByIndex: [],
        onWithheld: (w) => {
          at = w.at;
        },
      });
      expect((await metadata())[WITHHELD_PROPOSAL_KEY]).not.toHaveProperty("degraded");
      expect((await apply(at)).status).toBe(200);
      expect((await metadata()).synthesisDegraded).toEqual(DEGRADED);
    });

    it("apply on a promoted set records the newer run's promotion and its own matching notes", async () => {
      const pairing = (structuredId: string) => ({ structuredId, synthesisKeys: [] });
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis([{ title: "Kept" }, { title: "Gone" }, { title: "Untouched" }]),
        findingIdsByIndex: [],
        reviewStatus: "approved",
        promotedFrom: {
          runId: "run-1",
          pairings: [pairing("REQ-1"), pairing("REQ-2"), pairing("REQ-9")],
        },
      });
      const kept = (await byTitle("Kept"))!;
      const gone = (await byTitle("Gone"))!;
      const untouched = (await byTitle("Untouched"))!;
      // A person's review on Kept and Untouched withholds the next replacement.
      await db.requirement.updateMany({
        where: { id: { in: [kept.id, untouched.id] } },
        data: { reviewStatus: "rejected" },
      });
      const meta = await metadata();
      const note = (requirementId: string) => ({
        requirementId,
        structuredId: "REQ-x",
        candidates: [],
      });
      await db.analysis.update({
        where: { id: ANALYSIS },
        data: {
          metadata: JSON.stringify({
            ...meta,
            promotedStructuredIds: ["REQ-1", "REQ-2", "REQ-9"],
            promotedStructuredRunId: "run-1",
            promotionMatching: {
              ambiguousCount: 3,
              ambiguous: [note(kept.id), note(gone.id), note(untouched.id)],
              shared: [],
              updatedAt: "2026-10-01T00:00:00.000Z",
            },
          }),
        },
      });
      let at = "";
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis([{ title: "Kept", body: "Reworded." }, { title: "Added" }]),
        findingIdsByIndex: [],
        reviewStatus: "approved",
        promotedFrom: { runId: "run-2", pairings: [pairing("REQ-1"), pairing("REQ-3")] },
        // The run's own note: the title join could not decide REQ-3 (#1204).
        promotionMatches: {
          ambiguous: [
            {
              structuredId: "REQ-3",
              approvedIndex: 1,
              candidates: [{ title: "Added", acceptanceCriteria: [] }],
              synthesizedIndexes: [1],
            },
          ],
          shared: [],
        },
        onWithheld: (w) => {
          at = w.at;
        },
      });
      const res = await apply(at);
      expect(res.body.data).toMatchObject({ added: 1, updated: 1, deleted: 1, kept: 1 });
      const after = await metadata();
      expect(after.promotedStructuredIds).toEqual(["REQ-1", "REQ-3"]);
      expect(after.promotedStructuredRunId).toBe("run-2");
      const keptRow = await db.requirement.findUniqueOrThrow({ where: { id: kept.id } });
      expect(keptRow).toMatchObject({
        body: "Reworded.",
        reviewStatus: "rejected",
        promotedStructuredId: "REQ-1",
        promotedStructuredRunId: "run-2",
      });
      const added = (await byTitle("Added"))!;
      expect(added.promotedStructuredRunId).toBe("run-2");
      // Notes: the untouched row's earlier one stays, the deleted and rewritten
      // rows' earlier ones go, and the applied run's own one names its row.
      const matching = after.promotionMatching as {
        ambiguous: Array<{ requirementId: string; structuredId: string }>;
      };
      expect(matching.ambiguous.map((a) => [a.requirementId, a.structuredId])).toEqual([
        [untouched.id, "REQ-x"],
        [added.id, "REQ-3"],
      ]);
    });

    it("apply records a reviewed run that approved nothing, so the run's next approval appends", async () => {
      await persist([{ title: "Old" }]);
      const old = (await byTitle("Old"))!;
      await db.requirement.update({ where: { id: old.id }, data: { reviewStatus: "approved" } });
      const meta = await metadata();
      await db.analysis.update({
        where: { id: ANALYSIS },
        data: {
          metadata: JSON.stringify({
            ...meta,
            promotedStructuredIds: ["REQ-1"],
            promotedStructuredRunId: "run-1",
          }),
        },
      });
      let at = "";
      // The orchestrator's reviewed path with nothing approved: no rows, but a
      // promotion for run-2 all the same.
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis([]),
        findingIdsByIndex: [],
        reviewStatus: "approved",
        promotedFrom: { runId: "run-2", pairings: [] },
        onWithheld: (w) => {
          at = w.at;
        },
      });
      expect((await apply(at)).status).toBe(200);
      const after = await metadata();
      expect(after.promotedStructuredIds).toEqual([]);
      expect(after.promotedStructuredRunId).toBe("run-2");
      expect((await byTitle("Old"))!.reviewStatus).toBe("approved");
    });

    it("apply refuses (409) when a reviewed requirement was edited after the review, and writes nothing", async () => {
      const { at, approvedId } = await seedWithheld();
      const review = await getDiff();
      const fingerprint = review.body.data.fingerprint as string;
      // Someone edits the approved requirement between Review and Apply.
      await updateRequirementWithHistory(db as never, {
        requirementId: approvedId,
        patch: { body: "Edited after the review." },
        actorId: READER,
      });
      const before = await db.requirement.findMany({
        where: { analysisId: ANALYSIS },
        orderBy: { id: "asc" },
      });
      const res = await answer("apply", { at, fingerprint });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CHANGED_SINCE_REVIEW");
      expect(res.body.error.message).toMatch(/changed since you reviewed/);
      expect(
        await db.requirement.findMany({ where: { analysisId: ANALYSIS }, orderBy: { id: "asc" } }),
      ).toEqual(before);
      expect((await metadata())[WITHHELD_PROPOSAL_KEY]).toBeDefined();
      expect(auditSpy).not.toHaveBeenCalled();
      // A fresh review sees the edit, and its fingerprint applies.
      expect((await apply(at)).status).toBe(200);
    });

    it("apply refuses (409) when an unreviewed requirement gained review work after the review", async () => {
      const { at } = await seedWithheld();
      const fingerprint = (await getDiff()).body.data.fingerprint as string;
      // "Dropped" had no review work: the plan deleted it. A comment makes it
      // reviewed, so applying would now do something the confirmation did not say.
      const dropped = (await byTitle("Dropped"))!;
      await db.commentThread.create({
        data: { requirementId: dropped.id },
      });
      const res = await answer("apply", { at, fingerprint });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CHANGED_SINCE_REVIEW");
      expect(await db.requirement.findUnique({ where: { id: dropped.id } })).not.toBeNull();
      expect((await metadata())[WITHHELD_PROPOSAL_KEY]).toBeDefined();
    });

    it("apply refuses (409) when a reviewed requirement's status changed after the review", async () => {
      const { at, approvedId } = await seedWithheld();
      const fingerprint = (await getDiff()).body.data.fingerprint as string;
      // A verdict change is not versioned (#1162): approved → rejected leaves
      // `version` as it was, and the confirmation named it "Approved".
      const before = await db.requirement.findUniqueOrThrow({ where: { id: approvedId } });
      await db.requirement.update({
        where: { id: approvedId },
        data: { reviewStatus: "rejected" },
      });
      expect((await db.requirement.findUniqueOrThrow({ where: { id: approvedId } })).version).toBe(
        before.version,
      );
      const res = await answer("apply", { at, fingerprint });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CHANGED_SINCE_REVIEW");
      const after = await db.requirement.findUniqueOrThrow({ where: { id: approvedId } });
      expect(after.body).toBe(before.body);
      expect((await metadata())[WITHHELD_PROPOSAL_KEY]).toBeDefined();
    });
  },
);
