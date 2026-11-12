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
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { meRouter } = await import("../src/routes/me.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const P_MINE = "proj-mine-2348";
const P_OTHER = "proj-other-2348";
const P_DELETED = "proj-deleted-2348";

function openDialog(unanswered: number): string {
  const questions = Array.from({ length: unanswered + 1 }, (_, i) => ({ id: `q${i}` }));
  return JSON.stringify({
    analysisId: "x",
    currentRound: 1,
    maxRounds: 3,
    rounds: [{ round: 1, questions, answers: [{ questionId: "q0", answer: "Done" }] }],
    resolvedAmbiguities: [],
    escalatedToSonnet: false,
    completed: false,
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
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const work = async (auth: string): Promise<MyWorkResponse> => {
      const res = await request(app()).get("/api/me/work").set("Authorization", auth);
      expect(res.status).toBe(200);
      return res.body.data as MyWorkResponse;
    };

    async function run(id: string, projectId: string, startedById: string, metadata = "{}") {
      await db.analysis.create({
        data: { id, projectId, startedById, status: "completed", metadata },
      });
    }
    async function requirement(id: string, analysisId: string, projectId: string) {
      await db.requirement.create({ data: { id, analysisId, projectId, title: id, body: id } });
    }
    async function review(
      id: string,
      projectId: string,
      status: string,
      requirementId: string,
      updatedAt: Date,
      extra: { decidedAt?: Date; reviewerId?: string; decision?: string } = {},
    ) {
      await db.reviewRequest.create({
        data: {
          id,
          projectId,
          title: `Review ${id}`,
          status,
          requestedById: "u-boss",
          decidedAt: extra.decidedAt ?? null,
          items: { create: [{ requirementId, pinnedVersion: 1 }] },
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
      await db.document.create({
        data: {
          id: "doc-1",
          projectId: P_MINE,
          filename: "Payments BRD.docx",
          mimeType: "application/msword",
          sizeBytes: 1,
          storagePath: "x",
          checksum: "x",
          uploadedById: "u-ana",
        },
      });

      // Waiting on answers: 2 unanswered, titled from its document.
      await run("run-wait", P_MINE, "u-ana", JSON.stringify({ documentIds: ["doc-1"] }));
      await db.clarificationDialogState.create({
        data: { analysisId: "run-wait", state: openDialog(2) },
      });
      // A dialog with everything answered lists nothing.
      await run("run-answered", P_MINE, "u-ana");
      await db.clarificationDialogState.create({
        data: { analysisId: "run-answered", state: openDialog(0) },
      });
      // In review, rejected, approved.
      for (const [runId, status] of [
        ["run-review", "in_review"],
        ["run-rejected", "rejected"],
        ["run-ready", "approved"],
      ] as const) {
        await run(runId, P_MINE, "u-ana");
        await requirement(`req-${runId}`, runId, P_MINE);
        await review(`rev-${runId}`, P_MINE, status, `req-${runId}`, new Date("2026-11-02"), {
          decidedAt: status === "in_review" ? undefined : new Date("2026-11-01"),
        });
      }
      // An older approval superseded by a later rejection: rejected wins.
      await review("rev-old-ok", P_MINE, "approved", "req-run-rejected", new Date("2026-10-01"));
      // Someone else's run in my project, and a deleted run: never mine.
      await run("run-boss", P_MINE, "u-boss");
      await requirement("req-boss", "run-boss", P_MINE);
      await review("rev-boss", P_MINE, "in_review", "req-boss", new Date("2026-11-03"));
      await db.analysis.create({
        data: { id: "run-gone", projectId: P_MINE, startedById: "u-ana", deletedAt: new Date() },
      });
      await requirement("req-gone", "run-gone", P_MINE);
      await review("rev-gone", P_MINE, "in_review", "req-gone", new Date("2026-11-03"));
      // Ana's run in a project she can no longer open, and in a deleted project.
      for (const [runId, projectId] of [
        ["run-outside", P_OTHER],
        ["run-deleted-project", P_DELETED],
      ] as const) {
        await run(runId, projectId, "u-ana");
        await db.clarificationDialogState.create({
          data: { analysisId: runId, state: openDialog(1) },
        });
      }
      // An admin's own run in ws-other, where the admin is no member.
      await run("run-admin", P_OTHER, "u-admin");
      await db.clarificationDialogState.create({
        data: { analysisId: "run-admin", state: openDialog(3) },
      });

      // Reviews assigned to Ana: pending in her project (listed), pending in a
      // project outside her scope, already decided, and a draft (not listed).
      await requirement("req-a1", "run-boss", P_MINE);
      await review("rev-assigned", P_MINE, "in_review", "req-a1", new Date("2026-11-05"), {
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
      const data = await work(bearer("u-ana", "developer", ["ws-mine"]));
      const byId = Object.fromEntries(data.changeRequests.map((c) => [c.id, c]));
      expect(Object.keys(byId).sort()).toEqual(
        ["run-ready", "run-rejected", "run-review", "run-wait"].sort(),
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
        since: new Date("2026-11-01").toISOString(),
      });
      expect(byId["run-ready"]).toMatchObject({ state: "ready_to_hand_off" });
    });

    it("lists only pending reviews assigned to the caller in projects they can open", async () => {
      const data = await work(bearer("u-ana", "developer", ["ws-mine"]));
      expect(data.reviews).toEqual([
        expect.objectContaining({
          id: "rev-assigned",
          title: "Review rev-assigned",
          projectId: P_MINE,
          requestedBy: "Bo Lead",
        }),
      ]);
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
