/**
 * #2348 — `GET /api/me/work` through the REAL router, auth middleware and
 * project-scope rule against a REAL SQLite database built from the migration
 * chain. Nothing about access is mocked.
 *
 * Fixture: workspace `ws-mine` holds `u-ana` (analyst, `developer` role) and
 * `u-boss`; workspace `ws-other` holds only `u-boss`. `u-ana` started runs in
 * her own project in every state, plus one in `ws-other` (seeded directly, as
 * if she had since been removed): that one must never be listed for her, and
 * IS listed for an admin who started an equivalent run there.
 *
 * Dates are relative to the clock: the settled-state age bound
 * (`SETTLED_STATE_MAX_AGE_DAYS`) would otherwise turn fixed dates stale.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type MyWorkResponse, type RoleKey } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/prisma.js")>();
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const { meRouter } = await import("../src/routes/me.js");
const { reviewsRouter } = await import("../src/routes/reviews.js");
const { SETTLED_STATE_MAX_AGE_DAYS } = await import("../src/lib/my-work/my-work-service.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const P_MINE = "proj-mine-2348";
const P_OTHER = "proj-other-2348";
const P_DELETED = "proj-deleted-2348";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** Run metadata as the orchestrator writes it: clarification on, `open` left. */
function questionsMeta(open: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...extra,
    enhancement: { enableWebResearch: false, enableClarification: true },
    structuredRequirements: { requirements: [], totalAmbiguities: open },
  });
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2348 — GET /api/me/work lists the caller's own work in projects they can open",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const bearer = (userId: string, role: RoleKey, workspaces: string[]) =>
      `Bearer ${
        issueTokens({
          userId,
          username: userId,
          role,
          permissions: getPermissionsForRole(role),
          workspaces,
        }).accessToken
      }`;
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/me", meRouter());
      a.use("/api/reviews", reviewsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const work = async (auth: string): Promise<MyWorkResponse> => {
      const res = await request(app()).get("/api/me/work").set("Authorization", auth);
      expect(res.status).toBe(200);
      return res.body.data as MyWorkResponse;
    };
    const ANA = () => bearer("u-ana", "developer", ["ws-mine"]);

    async function run(
      id: string,
      projectId: string,
      startedById: string,
      metadata = "{}",
      status = "completed",
    ) {
      await db.analysis.create({
        data: { id, projectId, startedById, status, metadata, createdAt: daysAgo(90) },
      });
    }
    async function requirement(
      id: string,
      analysisId: string,
      projectId: string,
      deletedAt: Date | null = null,
    ) {
      await db.requirement.create({
        data: { id, analysisId, projectId, title: id, body: id, deletedAt },
      });
    }
    async function review(
      id: string,
      projectId: string,
      status: string,
      requirementIds: string | string[],
      updatedAt: Date,
      extra: { decidedAt?: Date; reviewerId?: string; decision?: string } = {},
    ) {
      const ids = Array.isArray(requirementIds) ? requirementIds : [requirementIds];
      await db.reviewRequest.create({
        data: {
          id,
          projectId,
          title: `Review ${id}`,
          status,
          requestedById: "u-boss",
          decidedAt: extra.decidedAt ?? null,
          items: { create: ids.map((requirementId) => ({ requirementId, pinnedVersion: 1 })) },
          ...(extra.reviewerId
            ? {
                assignments: {
                  create: [{ reviewerId: extra.reviewerId, decision: extra.decision ?? "pending" }],
                },
              }
            : {}),
        },
      });
      // `@updatedAt` is set on write; pin it so the "latest review" rule is tested.
      await db.reviewRequest.update({ where: { id }, data: { updatedAt } });
    }
    async function document(id: string, projectId: string, filename: string, deleted = false) {
      await db.document.create({
        data: {
          id,
          projectId,
          filename,
          mimeType: "application/msword",
          sizeBytes: 1,
          storagePath: "x",
          checksum: id,
          uploadedById: "u-ana",
          deletedAt: deleted ? new Date() : null,
        },
      });
    }

    const SUBMITTED = daysAgo(6);
    const DECIDED = daysAgo(3);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2348-my-work");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const [id, displayName] of [
        ["u-ana", "Ana Analyst"],
        ["u-boss", "Bo Lead"],
        ["u-admin", "Ad Min"],
        ["u-quiet", "Quiet User"],
      ]) {
        await db.user.create({
          data: { id, username: id, displayName, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-mine", name: "Mine", slug: "ws-mine" } });
      await db.workspace.create({ data: { id: "ws-other", name: "Other", slug: "ws-other" } });
      for (const userId of ["u-ana", "u-quiet"]) {
        await db.workspaceMember.create({
          data: { workspaceId: "ws-mine", userId, role: "member" },
        });
      }
      for (const ws of ["ws-mine", "ws-other"]) {
        await db.workspaceMember.create({
          data: { workspaceId: ws, userId: "u-boss", role: "owner" },
        });
      }
      for (const [id, workspaceId, deletedAt] of [
        [P_MINE, "ws-mine", null],
        [P_OTHER, "ws-other", null],
        [P_DELETED, "ws-mine", new Date()],
      ] as const) {
        await db.project.create({
          data: {
            id,
            name: `Project ${id}`,
            slug: id,
            createdById: "u-boss",
            workspaceId,
            status: "active",
            deletedAt,
          },
        });
      }
      await document("doc-1", P_MINE, "Payments BRD.docx");
      await document("doc-foreign", P_OTHER, "Other team secret.docx");
      await document("doc-deleted", P_MINE, "Withdrawn draft.docx", true);

      // Waiting on answers, the analyst has opened the Questions tab (a
      // dialog row exists) and 2 are still open; titled from its document.
      await run("run-wait", P_MINE, "u-ana", questionsMeta(2, { documentIds: ["doc-1"] }));
      await db.clarificationDialogState.create({ data: { analysisId: "run-wait", state: "{}" } });
      // #2330 live — a run completes with its questions open and NO dialog
      // row, because nobody has opened the Questions tab yet.
      await run("run-unopened", P_MINE, "u-ana", questionsMeta(12));
      // Everything answered: nothing listed, dialog row or not.
      await run("run-answered", P_MINE, "u-ana", questionsMeta(0));
      await db.clarificationDialogState.create({
        data: { analysisId: "run-answered", state: "{}" },
      });
      // Still running: its questions are not final yet.
      await run("run-running", P_MINE, "u-ana", questionsMeta(3), "running");
      // Source documents from another project and deleted: neither names it.
      await run(
        "run-docs",
        P_MINE,
        "u-ana",
        questionsMeta(1, {
          documentIds: ["doc-foreign", "doc-deleted"],
          sourceRequirements: [{ title: "PAY-7 Fallback title" }],
        }),
      );

      // In review, rejected, approved.
      for (const [runId, status] of [
        ["run-review", "in_review"],
        ["run-rejected", "rejected"],
        ["run-ready", "approved"],
      ] as const) {
        await run(runId, P_MINE, "u-ana");
        await requirement(`req-${runId}`, runId, P_MINE);
        await review(`rev-${runId}`, P_MINE, status, `req-${runId}`, daysAgo(2), {
          decidedAt: status === "in_review" ? undefined : DECIDED,
        });
      }
      // In review since its submit, though an edit bumped `updatedAt` later.
      await db.auditLog.create({
        data: {
          actorId: "u-ana",
          action: "review.submit",
          targetType: "review_request",
          targetId: "rev-run-review",
          ts: SUBMITTED,
        },
      });
      // An older approval superseded by a later rejection: rejected wins.
      await review("rev-old-ok", P_MINE, "approved", "req-run-rejected", daysAgo(20));
      // Approved, then handed off: one requirement published as an issue.
      await run("run-published", P_MINE, "u-ana");
      await requirement("req-published", "run-published", P_MINE);
      await review("rev-published", P_MINE, "approved", "req-published", daysAgo(2), {
        decidedAt: daysAgo(2),
      });
      await db.issueDraft.create({
        data: {
          projectId: P_MINE,
          requirementId: "req-published",
          title: "t",
          body: "b",
          status: "published",
        },
      });
      // Approved, with an issue draft not yet published: still ready.
      await run("run-drafted", P_MINE, "u-ana");
      await requirement("req-drafted", "run-drafted", P_MINE);
      await review("rev-drafted", P_MINE, "approved", "req-drafted", daysAgo(2), {
        decidedAt: daysAgo(2),
      });
      await db.issueDraft.create({
        data: { projectId: P_MINE, requirementId: "req-drafted", title: "t", body: "b" },
      });
      // Rejected long ago and abandoned: aged out.
      await run("run-stale", P_MINE, "u-ana");
      await requirement("req-stale", "run-stale", P_MINE);
      const stale = daysAgo(SETTLED_STATE_MAX_AGE_DAYS + 5);
      await review("rev-stale", P_MINE, "rejected", "req-stale", stale, { decidedAt: stale });
      // Approved, then sent back to draft for revision: the old verdict no
      // longer stands, so nothing is listed.
      await run("run-revising", P_MINE, "u-ana");
      await requirement("req-revising", "run-revising", P_MINE);
      await review("rev-revising-old", P_MINE, "approved", "req-revising", daysAgo(5), {
        decidedAt: daysAgo(5),
      });
      await review("rev-revising", P_MINE, "draft", "req-revising", daysAgo(1));
      // One review over a live requirement of run-mixed and a DELETED one of
      // run-delreq: run-mixed is in review, run-delreq is not.
      await run("run-mixed", P_MINE, "u-ana");
      await requirement("req-mixed", "run-mixed", P_MINE);
      await run("run-delreq", P_MINE, "u-ana");
      await requirement("req-del", "run-delreq", P_MINE, new Date());
      await review("rev-mixed", P_MINE, "in_review", ["req-mixed", "req-del"], daysAgo(1));

      // Someone else's run in my project, and a deleted run: never mine.
      await run("run-boss", P_MINE, "u-boss", questionsMeta(4));
      await requirement("req-boss", "run-boss", P_MINE);
      await review("rev-boss", P_MINE, "in_review", "req-boss", daysAgo(1));
      await db.analysis.create({
        data: {
          id: "run-gone",
          projectId: P_MINE,
          startedById: "u-ana",
          status: "completed",
          metadata: questionsMeta(4),
          deletedAt: new Date(),
        },
      });
      await requirement("req-gone", "run-gone", P_MINE);
      await review("rev-gone", P_MINE, "in_review", "req-gone", daysAgo(1));
      // Ana's run in a project she can no longer open, and in a deleted project.
      for (const [runId, projectId] of [
        ["run-outside", P_OTHER],
        ["run-deleted-project", P_DELETED],
      ] as const) {
        await run(runId, projectId, "u-ana", questionsMeta(1));
      }
      // An admin's own run in ws-other, where the admin is no member.
      await run("run-admin", P_OTHER, "u-admin", questionsMeta(3));

      // Reviews assigned to Ana: pending in her project (listed), pending in a
      // project outside her scope, already decided, and a draft (not listed).
      await requirement("req-a1", "run-boss", P_MINE);
      await review("rev-assigned", P_MINE, "in_review", "req-a1", daysAgo(1), {
        reviewerId: "u-ana",
      });
      await run("run-boss-other", P_OTHER, "u-boss");
      await requirement("req-a2", "run-boss-other", P_OTHER);
      await review("rev-assigned-outside", P_OTHER, "in_review", "req-a2", new Date(), {
        reviewerId: "u-ana",
      });
      await requirement("req-a3", "run-boss", P_MINE);
      await review("rev-decided", P_MINE, "in_review", "req-a3", new Date(), {
        reviewerId: "u-ana",
        decision: "approved",
      });
      await requirement("req-a4", "run-boss", P_MINE);
      await review("rev-draft", P_MINE, "draft", "req-a4", new Date(), { reviewerId: "u-ana" });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("401s without a session and takes no user id from the request", async () => {
      const res = await request(app()).get("/api/me/work?userId=u-boss");
      expect(res.status).toBe(401);
    });

    it("groups the analyst's change requests by state, with title, project and since", async () => {
      const data = await work(ANA());
      const byId = Object.fromEntries(data.changeRequests.map((c) => [c.id, c]));
      expect(Object.keys(byId).sort()).toEqual(
        [
          "run-docs",
          "run-drafted",
          "run-mixed",
          "run-ready",
          "run-rejected",
          "run-review",
          "run-unopened",
          "run-wait",
        ].sort(),
      );
      expect(byId["run-wait"]).toMatchObject({
        state: "waiting_on_me",
        openQuestions: 2,
        title: "Payments BRD.docx",
        projectId: P_MINE,
        projectName: `Project ${P_MINE}`,
      });
      expect(byId["run-review"]).toMatchObject({ state: "in_review", reviewId: "rev-run-review" });
      expect(byId["run-rejected"]).toMatchObject({
        state: "rejected",
        reviewId: "rev-run-rejected",
        since: DECIDED.toISOString(),
      });
      expect(byId["run-ready"]).toMatchObject({ state: "ready_to_hand_off" });
    });

    it("lists a completed run with open questions nobody has opened yet (#2330)", async () => {
      const data = await work(ANA());
      expect(data.changeRequests.find((c) => c.id === "run-unopened")).toMatchObject({
        state: "waiting_on_me",
        // The Questions tab's count: the run's remaining ambiguities.
        openQuestions: 12,
      });
      const ids = data.changeRequests.map((c) => c.id);
      expect(ids).not.toContain("run-answered");
      expect(ids).not.toContain("run-running");
    });

    it("dates in review from the submit, not from the review's last edit", async () => {
      const data = await work(ANA());
      expect(data.changeRequests.find((c) => c.id === "run-review")?.since).toBe(
        SUBMITTED.toISOString(),
      );
    });

    it("drops a ready change request once a requirement is published, and stale verdicts", async () => {
      const ids = (await work(ANA())).changeRequests.map((c) => c.id);
      expect(ids).not.toContain("run-published");
      expect(ids).toContain("run-drafted");
      expect(ids).not.toContain("run-stale");
    });

    it("lists nothing for a run whose review went back to draft over an older approval", async () => {
      const ids = (await work(ANA())).changeRequests.map((c) => c.id);
      expect(ids).not.toContain("run-revising");
    });

    it("does not attribute a review to a run through a deleted requirement", async () => {
      const data = await work(ANA());
      const ids = data.changeRequests.map((c) => c.id);
      expect(data.changeRequests.find((c) => c.id === "run-mixed")).toMatchObject({
        state: "in_review",
        reviewId: "rev-mixed",
      });
      expect(ids).not.toContain("run-delreq");
    });

    it("never names a run after a document from another project or a deleted one", async () => {
      const data = await work(ANA());
      const docs = data.changeRequests.find((c) => c.id === "run-docs");
      expect(docs?.title).toBe("PAY-7 Fallback title");
    });

    it("lists only pending reviews assigned to the caller in projects they can open", async () => {
      const data = await work(ANA());
      expect(data.reviews).toEqual([
        expect.objectContaining({
          id: "rev-assigned",
          title: "Review rev-assigned",
          projectId: P_MINE,
          requestedBy: "Bo Lead",
        }),
      ]);
    });

    it("counts the same reviews as the queue's assignee=me&status=in_review&decision=pending", async () => {
      const home = (await work(ANA())).reviews.map((r) => r.id).sort();
      const res = await request(app())
        .get("/api/reviews?assignee=me&status=in_review&decision=pending")
        .set("Authorization", ANA());
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(home.length);
      expect(res.body.data.reviews.map((r: { id: string }) => r.id).sort()).toEqual(home);
      // Without decision=pending the queue keeps the review Ana already decided.
      const all = await request(app())
        .get("/api/reviews?assignee=me&status=in_review")
        .set("Authorization", ANA());
      expect(all.body.data.reviews.map((r: { id: string }) => r.id)).toContain("rev-decided");
    });

    it("refuses a decision filter other than pending with assignee=me", async () => {
      for (const q of ["decision=approved&assignee=me", "decision=pending"]) {
        const res = await request(app()).get(`/api/reviews?${q}`).set("Authorization", ANA());
        expect(res.status).toBe(400);
      }
      const drafts = await request(app())
        .get("/api/reviews?assignee=me&status=draft&decision=pending")
        .set("Authorization", ANA());
      expect(drafts.body.data.total).toBe(0);
    });

    it("lists nothing from another workspace even when the token claims it", async () => {
      // The claim names ws-other, but Ana has no membership row there (#561).
      const data = await work(bearer("u-ana", "developer", ["ws-mine", "ws-other"]));
      expect(data.changeRequests.map((c) => c.id)).not.toContain("run-outside");
      expect(data.reviews.map((r) => r.id)).not.toContain("rev-assigned-outside");
    });

    it("gives an admin their own work in every live project, and nobody else's", async () => {
      const data = await work(bearer("u-admin", "admin", []));
      expect(data.changeRequests).toEqual([
        expect.objectContaining({ id: "run-admin", state: "waiting_on_me", openQuestions: 3 }),
      ]);
      expect(data.reviews).toEqual([]);
      // Every live project; the deleted one is not counted even for an admin.
      expect(data.projectCount).toBe(2);
    });

    it("answers empty lists for a user with nothing", async () => {
      expect(await work(bearer("u-quiet", "developer", ["ws-mine"]))).toEqual({
        changeRequests: [],
        reviews: [],
        // P_MINE only: P_OTHER is another workspace's, P_DELETED is deleted.
        projectCount: 1,
      });
    });
  },
);
