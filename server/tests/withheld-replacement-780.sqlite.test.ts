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
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-780";
const OTHER_WS = "ws-780-x";
const PROJECT = "p-780";
const OTHER_PROJECT = "p-780-x";
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

    beforeAll(async () => {
      sqlite = createMigratedSqlite("780-withheld-replacement");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: "ws", slug: WS } });
      for (const id of [ANALYST, READER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.workspaceMember.create({ data: { workspaceId: WS, userId: id, role: "member" } });
      }
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: ANALYST, workspaceId: WS },
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
      const res = await answer("apply", { at });
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
      expect((await answer("apply", { at })).body.error.code).toBe("NO_PROPOSAL");
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
      expect((await answer("apply", { at })).body.data.updated).toBe(0);
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
          metadata: { projectId: PROJECT, discarded: 4 },
        }),
      );
      const again = await answer("dismiss", { at });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("NO_PROPOSAL");
    });

    it("refuses a stale answer, another project, a reader, a bad body and an unknown choice", async () => {
      const { at } = await seedWithheld();
      const stale = await answer("apply", { at: "2020-01-01T00:00:00.000Z" });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe("STALE");
      expect((await answer("apply", { at }, OTHER_PROJECT)).status).toBe(404);
      expect((await getDiff(OTHER_PROJECT)).status).toBe(404);
      expect((await answer("apply", { at }, PROJECT, READER_TOKEN)).status).toBe(403);
      expect((await answer("dismiss", { at }, PROJECT, READER_TOKEN)).status).toBe(403);
      expect((await answer("apply", {})).status).toBe(400);
      expect((await answer("apply", { at: 5 })).status).toBe(400);
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
      expect((await answer("apply", { at })).body.error.code).toBe("STALE");
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
      const res = await answer("apply", { at });
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
      expect((await answer("apply", { at })).body.data.added).toBe(1);
      const added = (await byTitle("Added"))!;
      expect(added.reviewStatus).toBe("approved");
      const ids = (await metadata()).checkpointApprovedRequirementIds as string[];
      expect(ids).toContain(added.id);
      expect(ids).toContain(edited.id);
    });
  },
);
