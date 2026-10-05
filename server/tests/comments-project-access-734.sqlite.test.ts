/**
 * #734 (remainder) — requirement comments and Spec Kit artifact comments follow
 * the project-access rule, as discussions do since PR #850.
 *
 * Both used a local copy of the scheduler's creator-only rule, so a workspace
 * member who did not CREATE the project got 403 "Insufficient project access"
 * on a thread they had just been @mentioned in. They now go through the
 * canonical `assertProjectAccess` seam: a member is admitted, a non-member gets
 * the same 404 an unknown id gets, and the denial is audited.
 *
 * Also pinned here, on the same seam:
 *   - the @mention autocomplete (`GET /api/users?projectId=`) offers only users
 *     who can open the project;
 *   - a comment @mention notifies only those users, and links to the
 *     requirement or artifact holding the comment instead of `/comments/<id>`,
 *     which has no page (#735).
 *
 * Real routers, real JWT auth, a real SQLite database from the migration chain.
 * No access helper is mocked; only the audit sink is spied on.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const audit = vi.fn();
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: (...a: unknown[]) => audit(...a),
}));

const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { commentsRouter, specKitArtifactCommentsRouter } = await import("../src/routes/comments.js");
const { usersRouter } = await import("../src/routes/users.js");
const { fanOutMentions } = await import("../src/lib/collaboration/mentions.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

type Method = "get" | "post" | "patch" | "delete";

const WS = "ws-734";
const WS_OTHER = "ws-734-other";
const PROJECT = "proj-734";
const ANALYSIS = "ana-734";
const REQ = "req-734";
const ARTIFACT = "spec.md";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#734 — comments follow the project-access rule",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ADMIN = "";
    let MEMBER = ""; // workspace member, did NOT create the project
    let OUTSIDER = ""; // developer in another workspace only

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use("/api/comments", commentsRouter());
      a.use("/api/users", usersRouter());
      a.use(
        "/api/projects/:projectId/spec-kit/artifacts/:artifactName/comments",
        specKitArtifactCommentsRouter(),
      );
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const call = (method: Method, url: string, bearer: string, body?: Record<string, unknown>) => {
      const r = request(app())[method](url).set("Authorization", `Bearer ${bearer}`);
      return body ? r.send(body) : r;
    };
    const developer = (userId: string, workspaces: string[]) =>
      issueTokens({ userId, username: userId, role: "developer", permissions: [], workspaces })
        .accessToken;

    /** A requirement thread and a Spec Kit thread, each with one comment by the author. */
    const seedThreads = async () => {
      const reqThread = await db.commentThread.create({
        data: {
          requirementId: REQ,
          comments: { create: { authorId: "u-author", body: "requirement comment" } },
        },
        include: { comments: true },
      });
      const artifactThread = await db.commentThread.create({
        data: {
          specKitProjectId: PROJECT,
          specKitArtifactName: ARTIFACT,
          comments: { create: { authorId: "u-author", body: "artifact comment" } },
        },
        include: { comments: true },
      });
      return {
        reqThreadId: reqThread.id,
        reqCommentId: reqThread.comments[0]!.id,
        artifactThreadId: artifactThread.id,
        artifactCommentId: artifactThread.comments[0]!.id,
      };
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("734-comments-project-access");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const [id, displayName] of [
        ["u-admin", "System Admin"],
        ["u-author", "Alice Author"],
        ["u-member", "Mia Member"],
        ["u-out", "Oscar Outsider"],
      ] as const) {
        await db.user.create({
          data: { id, username: id, displayName, email: `${id}@example.test` },
        });
      }
      const adminRole = await db.role.create({ data: { key: "admin", name: "Admin" } });
      await db.userRole.create({ data: { userId: "u-admin", roleId: adminRole.id } });
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await db.workspace.create({ data: { id: WS_OTHER, name: WS_OTHER, slug: WS_OTHER } });
      for (const [workspaceId, userId] of [
        [WS, "u-author"],
        [WS, "u-member"],
        [WS_OTHER, "u-out"],
      ] as const) {
        await db.workspaceMember.create({ data: { workspaceId, userId, role: "member" } });
      }
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: "u-author",
          workspaceId: WS,
        },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: "u-author", status: "completed" },
      });
      await db.requirement.create({
        data: {
          id: REQ,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: "Feeds refresh on schedule",
          body: "b",
        },
      });

      ADMIN = issueTokens({
        userId: "u-admin",
        username: "u-admin",
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
      MEMBER = developer("u-member", [WS]);
      OUTSIDER = developer("u-out", [WS_OTHER]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      audit.mockClear();
    });

    // ── requirement comments ────────────────────────────────────────────────
    describe("requirement comments", () => {
      it("admits a workspace member who did not create the project", async () => {
        await seedThreads();

        const list = await call("get", `/api/requirements/${REQ}/comments`, MEMBER);
        expect(list.status).toBe(200);
        expect(list.body.data.length).toBeGreaterThan(0);

        const created = await call("post", `/api/requirements/${REQ}/comments`, MEMBER, {
          body: "member comment",
        });
        expect(created.status).toBe(201);
      });

      it("answers a non-member the unknown-requirement 404, and audits it", async () => {
        const denied = await call("get", `/api/requirements/${REQ}/comments`, OUTSIDER);
        const unknown = await call("get", `/api/requirements/req-nope/comments`, OUTSIDER);

        expect(denied.status).toBe(404);
        expect(denied.body).toEqual(unknown.body);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            actor: { id: "u-out" },
            action: "requirement.access.denied",
            target: { type: "requirement", id: REQ },
          }),
        );
      });

      it("refuses a non-member's new thread with the same 404 and writes nothing", async () => {
        const before = await db.commentThread.count({ where: { requirementId: REQ } });

        const res = await call("post", `/api/requirements/${REQ}/comments`, OUTSIDER, {
          body: "should not land",
        });

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
        expect(await db.commentThread.count({ where: { requirementId: REQ } })).toBe(before);
      });
    });

    // ── Spec Kit artifact comments ──────────────────────────────────────────
    describe("Spec Kit artifact comments", () => {
      const url = (projectId: string) =>
        `/api/projects/${projectId}/spec-kit/artifacts/${ARTIFACT}/comments`;

      it("admits a workspace member who did not create the project", async () => {
        await seedThreads();

        const list = await call("get", url(PROJECT), MEMBER);
        expect(list.status).toBe(200);
        expect(list.body.data.length).toBeGreaterThan(0);

        const created = await call("post", url(PROJECT), MEMBER, { body: "member comment" });
        expect(created.status).toBe(201);
      });

      it("answers a non-member the unknown-project 404, and audits it", async () => {
        const denied = await call("get", url(PROJECT), OUTSIDER);
        const unknown = await call("get", url("proj-nope"), OUTSIDER);

        expect(denied.status).toBe(404);
        expect(denied.body).toEqual(unknown.body);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            actor: { id: "u-out" },
            action: "comment.access.denied",
            target: { type: "spec_kit_artifact", id: `${PROJECT}:${ARTIFACT}` },
            metadata: expect.objectContaining({ reason: "project-access-denied" }),
          }),
        );
      });

      it("refuses a non-member's new thread with the same 404 and writes nothing", async () => {
        const before = await db.commentThread.count({ where: { specKitProjectId: PROJECT } });

        const res = await call("post", url(PROJECT), OUTSIDER, { body: "should not land" });

        expect(res.status).toBe(404);
        expect(await db.commentThread.count({ where: { specKitProjectId: PROJECT } })).toBe(before);
      });

      it("still admits a system admin", async () => {
        expect((await call("get", url(PROJECT), ADMIN)).status).toBe(200);
      });
    });

    // ── replies, edits, deletes by id ───────────────────────────────────────
    describe("by-id routes (replies, edit, delete)", () => {
      it("lets a member reply in both kinds of thread", async () => {
        const t = await seedThreads();

        for (const threadId of [t.reqThreadId, t.artifactThreadId]) {
          const res = await call("post", `/api/comments/${threadId}/replies`, MEMBER, {
            body: "member reply",
          });
          expect(res.status).toBe(201);
        }
      });

      it("lets a member edit and delete their own comment", async () => {
        const t = await seedThreads();
        const reply = await call("post", `/api/comments/${t.artifactThreadId}/replies`, MEMBER, {
          body: "to edit",
        });
        const id = reply.body.data.id as string;

        expect(
          (await call("patch", `/api/comments/${id}`, MEMBER, { body: "edited" })).status,
        ).toBe(200);
        expect((await call("delete", `/api/comments/${id}`, MEMBER)).status).toBe(200);
      });

      it("answers a non-member's reply the unknown-thread 404, and audits it", async () => {
        const t = await seedThreads();

        for (const threadId of [t.reqThreadId, t.artifactThreadId]) {
          audit.mockClear();
          const denied = await call("post", `/api/comments/${threadId}/replies`, OUTSIDER, {
            body: "x",
          });
          const unknown = await call("post", `/api/comments/thread-nope/replies`, OUTSIDER, {
            body: "x",
          });
          expect(denied.status).toBe(404);
          expect(denied.body).toEqual(unknown.body);
          expect(audit).toHaveBeenCalledWith(
            expect.objectContaining({
              action: "comment.access.denied",
              target: { type: "comment_thread", id: threadId },
            }),
          );
        }
      });

      it("answers a non-member's edit and delete the unknown-comment 404", async () => {
        const t = await seedThreads();

        for (const commentId of [t.reqCommentId, t.artifactCommentId]) {
          const unknownEdit = await call("patch", `/api/comments/c-nope`, OUTSIDER, { body: "x" });
          const edit = await call("patch", `/api/comments/${commentId}`, OUTSIDER, { body: "x" });
          expect(edit.status).toBe(404);
          expect(edit.body).toEqual(unknownEdit.body);

          const unknownDelete = await call("delete", `/api/comments/c-nope`, OUTSIDER);
          const del = await call("delete", `/api/comments/${commentId}`, OUTSIDER);
          expect(del.status).toBe(404);
          expect(del.body).toEqual(unknownDelete.body);

          const row = await db.comment.findUniqueOrThrow({ where: { id: commentId } });
          expect(row.deletedAt).toBeNull();
          expect(row.body).not.toBe("x");
        }
      });

      it("keeps author-only editing for members (403 on another member's comment)", async () => {
        const t = await seedThreads();

        const res = await call("patch", `/api/comments/${t.reqCommentId}`, MEMBER, { body: "x" });

        expect(res.status).toBe(403);
      });
    });

    // ── mention autocomplete ────────────────────────────────────────────────
    describe("GET /api/users?projectId= — mention autocomplete", () => {
      const usernames = (res: request.Response) =>
        (res.body.data as Array<{ username: string }>).map((u) => u.username).sort();

      it("offers only users who can open the project", async () => {
        const res = await call("get", `/api/users?search=u-&projectId=${PROJECT}`, MEMBER);

        expect(res.status).toBe(200);
        expect(usernames(res)).toEqual(["u-admin", "u-author", "u-member"]);
      });

      it("offers everyone without a projectId (unchanged)", async () => {
        const res = await call("get", `/api/users?search=u-`, MEMBER);

        expect(usernames(res)).toEqual(["u-admin", "u-author", "u-member", "u-out"]);
      });

      it("offers everyone on a legacy project with no workspace", async () => {
        await db.project.create({
          data: {
            id: "proj-734-legacy",
            name: "legacy",
            slug: "proj-734-legacy",
            createdById: "u-author",
          },
        });

        const res = await call("get", "/api/users?search=u-&projectId=proj-734-legacy", OUTSIDER);

        expect(usernames(res)).toEqual(["u-admin", "u-author", "u-member", "u-out"]);
      });

      it("offers only system admins on a soft-deleted project", async () => {
        await db.project.create({
          data: {
            id: "proj-734-gone",
            name: "gone",
            slug: "proj-734-gone",
            createdById: "u-author",
            workspaceId: WS,
            deletedAt: new Date(),
          },
        });

        const res = await call("get", "/api/users?search=u-&projectId=proj-734-gone", ADMIN);

        expect(usernames(res)).toEqual(["u-admin"]);
      });

      it("answers a non-member the unknown-project 404 rather than a member list", async () => {
        const denied = await call("get", `/api/users?search=u-&projectId=${PROJECT}`, OUTSIDER);
        const unknown = await call("get", `/api/users?search=u-&projectId=proj-nope`, OUTSIDER);

        expect(denied.status).toBe(404);
        expect(denied.body).toEqual(unknown.body);
      });
    });

    // ── mention delivery + link (#735) ──────────────────────────────────────
    describe("comment @mention notifications", () => {
      beforeEach(async () => {
        await db.notification.deleteMany({});
      });

      it("notifies a member with a link to the requirement, and skips a non-member", async () => {
        const t = await seedThreads();

        await fanOutMentions(t.reqCommentId, "@u-member @u-out please look", "u-author");

        const rows = await db.notification.findMany({ where: { type: "mention" } });
        expect(rows.map((r) => r.userId)).toEqual(["u-member"]);
        expect(rows[0]!.href).toBe(
          `/projects/${PROJECT}/analysis?analysisId=${ANALYSIS}&requirementId=${REQ}`,
        );
        expect(rows[0]!.message).toBe(`Alice Author mentioned you on "Feeds refresh on schedule"`);
      });

      it("links an artifact comment mention to the artifact", async () => {
        const t = await seedThreads();

        await fanOutMentions(t.artifactCommentId, "@u-member see this", "u-author");

        const rows = await db.notification.findMany({ where: { type: "mention" } });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.href).toBe(`/projects/${PROJECT}/spec-kit?artifact=${ARTIFACT}`);
        expect(rows[0]!.message).toBe(`Alice Author mentioned you on ${ARTIFACT}`);
      });

      it("notifies a system admin who is not a workspace member", async () => {
        const t = await seedThreads();

        await fanOutMentions(t.reqCommentId, "@u-admin FYI", "u-author");

        const rows = await db.notification.findMany({ where: { type: "mention" } });
        expect(rows.map((r) => r.userId)).toEqual(["u-admin"]);
      });
    });
  },
);
