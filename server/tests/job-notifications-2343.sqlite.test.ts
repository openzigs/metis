/**
 * #2343 — telling the analyst when something needs them, through the REAL
 * notifier, routes, auth middleware and project-scope rule against a REAL
 * SQLite database built from the migration chain. Only the socket server is a
 * double, to see what reaches the starter's personal room.
 *
 * Fixture: workspace `ws-a` holds `u-ana` (the analyst, `developer` role) and
 * `u-rev` (a reviewer); `u-out` is in `ws-x` only and can never open `P`.
 *
 * Covers: one bell row per completion, idempotent on a repeated call; the
 * `inApp × jobFinished` preference; no row for a recipient who cannot open the
 * project at write time, and the read-time re-check once access is lost
 * (#1447); the toast event on `user:{id}`; "Questions waiting (N)" on the
 * change-request list; and the change request's review state for the caller.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, userRoom, type RoleKey } from "@metis/shared";
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
const emit = vi.fn();
const to = vi.fn((_room: string) => ({ emit }));
vi.mock("../src/lib/socket/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socket/registry.js")>()),
  getSocketServer: () => ({ to }),
}));

const { notifyJobOutcome } = await import("../src/lib/notifications/job-notify.js");
const { notificationsRouter } = await import("../src/routes/notifications.js");
const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const P = "proj-2343";
const P_X = "proj-2343-x";
const RUN = "ana-2343";
const RUN_QUIET = "ana-2343-quiet";
const RUN_X = "ana-2343-x";

const meta = (open: number) =>
  JSON.stringify({
    enhancement: { enableClarification: true },
    structuredRequirements: { requirements: [], totalAmbiguities: open },
  });

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2343 — job outcomes, questions waiting and review states",
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
    const ANA = () => bearer("u-ana", "developer", ["ws-a"]);
    const REV = () => bearer("u-rev", "developer", ["ws-a"]);
    const OUT = () => bearer("u-out", "developer", ["ws-x"]);
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/notifications", notificationsRouter());
      const routers = initAnalysisRouter({
        orchestrator: { start: vi.fn() } as unknown as NonNullable<
          Parameters<typeof initAnalysisRouter>[0]
        >["orchestrator"],
      });
      a.use("/api/projects/:projectId/analyses", routers.projectScoped);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const rows = (userId: string) =>
      db.notification.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2343-job-notifications");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-ana", "u-rev", "u-out"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-a", name: "a", slug: "ws-a" } });
      await db.workspace.create({ data: { id: "ws-x", name: "x", slug: "ws-x" } });
      for (const [userId, workspaceId] of [
        ["u-ana", "ws-a"],
        ["u-rev", "ws-a"],
        ["u-out", "ws-x"],
      ] as const) {
        await db.workspaceMember.create({ data: { workspaceId, userId, role: "member" } });
      }
      await db.project.create({
        data: { id: P, name: P, slug: P, createdById: "u-ana", workspaceId: "ws-a" },
      });
      await db.project.create({
        data: { id: P_X, name: P_X, slug: P_X, createdById: "u-out", workspaceId: "ws-x" },
      });
      await db.analysis.create({
        data: {
          id: RUN,
          projectId: P,
          startedById: "u-ana",
          status: "completed",
          title: "Checkout\nredesign",
          metadata: meta(3),
        },
      });
      await db.analysis.create({
        data: {
          id: RUN_QUIET,
          projectId: P,
          startedById: "u-ana",
          status: "running",
          metadata: meta(5),
        },
      });
      await db.analysis.create({
        data: { id: RUN_X, projectId: P_X, startedById: "u-out", status: "completed" },
      });
      for (const [id, analysisId, projectId] of [
        ["req-1", RUN, P],
        ["req-2", RUN, P],
        ["req-x", RUN_X, P_X],
      ] as const) {
        await db.requirement.create({
          data: { id, analysisId, projectId, title: id, body: id },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      emit.mockClear();
      to.mockClear();
    });

    describe("a finished job", () => {
      it("writes one bell row naming the change request, with its open questions and link", async () => {
        const id = await notifyJobOutcome({
          kind: "analysis",
          jobId: RUN,
          projectId: P,
          userId: "u-ana",
          outcome: "completed",
        });
        expect(id).toEqual(expect.any(String));
        const [row] = await rows("u-ana");
        expect(row).toMatchObject({
          id,
          type: "job_completed",
          projectId: P,
          title: 'Change request "Checkout redesign" is ready',
          message: "Questions waiting (3): open the change request to answer them.",
          href: `/projects/${P}/analysis?analysisId=${RUN}`,
          read: false,
        });
        // The toast event reaches the starter's personal room only, with the row's id.
        expect(to).toHaveBeenCalledWith(userRoom("u-ana"));
        expect(emit).toHaveBeenCalledWith(
          "job:notification",
          expect.objectContaining({
            notificationId: id,
            kind: "job_completed",
            jobKind: "analysis",
            jobId: RUN,
            subject: "Checkout redesign",
            href: `/projects/${P}/analysis?analysisId=${RUN}`,
          }),
        );
      });

      it("is idempotent: the same outcome again writes and emits nothing", async () => {
        const again = await notifyJobOutcome({
          kind: "analysis",
          jobId: RUN,
          projectId: P,
          userId: "u-ana",
          outcome: "completed",
        });
        expect(again).toBeNull();
        expect(emit).not.toHaveBeenCalled();
        expect((await rows("u-ana")).filter((r) => r.type === "job_completed")).toHaveLength(1);
      });

      it("says a failure in plain words and links to where it can be run again", async () => {
        await notifyJobOutcome({
          kind: "doc-generation",
          jobId: "doc-1",
          projectId: P,
          userId: "u-ana",
          outcome: "failed",
          subject: "Architecture overview",
          dedupeKey: "doc-generation:doc-1:claim-a:failed",
        });
        const row = (await rows("u-ana")).find((r) => r.type === "job_failed")!;
        expect(row.title).toBe('Document "Architecture overview" failed to generate');
        expect(row.message).toMatch(/could not be generated/);
        expect(row.href).toBe(`/projects/${P}/documentation?doc=doc-1`);
        // A regeneration of the same document is a new run: told again.
        expect(
          await notifyJobOutcome({
            kind: "doc-generation",
            jobId: "doc-1",
            projectId: P,
            userId: "u-ana",
            outcome: "failed",
            subject: "Architecture overview",
            dedupeKey: "doc-generation:doc-1:claim-b:failed",
          }),
        ).toEqual(expect.any(String));
      });

      it("honours the inApp × jobFinished preference", async () => {
        await db.notificationPreference.create({
          data: { userId: "u-rev", channel: "inApp", event: "jobFinished", enabled: false },
        });
        expect(
          await notifyJobOutcome({
            kind: "document-ingest",
            jobId: "d-1",
            projectId: P,
            userId: "u-rev",
            outcome: "awaiting-review",
            subject: "brief.docx",
          }),
        ).toBeNull();
        expect(await rows("u-rev")).toHaveLength(0);
        expect(emit).not.toHaveBeenCalled();
        await db.notificationPreference.deleteMany({ where: { userId: "u-rev" } });
      });

      it("writes nothing for a recipient who cannot open the project", async () => {
        expect(
          await notifyJobOutcome({
            kind: "analysis",
            jobId: RUN,
            projectId: P,
            userId: "u-out",
            outcome: "failed",
          }),
        ).toBeNull();
        expect(await rows("u-out")).toHaveLength(0);
        expect(emit).not.toHaveBeenCalled();
      });

      it("sends nothing without a starter (a run the system started)", async () => {
        expect(
          await notifyJobOutcome({
            kind: "analysis",
            jobId: RUN,
            projectId: P,
            userId: null,
            outcome: "completed",
          }),
        ).toBeNull();
      });

      it("re-checks access when the bell is read: a lost project comes back redacted", async () => {
        await notifyJobOutcome({
          kind: "document-ingest",
          jobId: "d-2",
          projectId: P,
          userId: "u-rev",
          outcome: "completed",
          subject: "secret-merger.docx",
        });
        const before = await request(app()).get("/api/notifications").set("Authorization", REV());
        expect(before.status).toBe(200);
        expect(before.body.data.notifications[0]).toMatchObject({
          type: "job_completed",
          title: 'Document "secret-merger.docx" is ready to use',
          redacted: false,
        });

        await db.workspaceMember.deleteMany({ where: { userId: "u-rev" } });
        const after = await request(app()).get("/api/notifications").set("Authorization", REV());
        expect(after.body.data.notifications[0]).toMatchObject({
          type: "unavailable",
          title: "Notification unavailable",
          href: null,
          redacted: true,
        });
        expect(JSON.stringify(after.body)).not.toContain("secret-merger");
        await db.workspaceMember.create({
          data: { workspaceId: "ws-a", userId: "u-rev", role: "member" },
        });
      });
    });

    describe("questions waiting on the change-request list", () => {
      it("counts open questions on a completed run only", async () => {
        const res = await request(app())
          .get(`/api/projects/${P}/analyses`)
          .set("Authorization", ANA());
        expect(res.status).toBe(200);
        const items = res.body.data.items as Array<{ id: string; openQuestions?: number }>;
        expect(items.find((i) => i.id === RUN)?.openQuestions).toBe(3);
        // Still running: its questions are not waiting yet.
        expect(items.find((i) => i.id === RUN_QUIET)?.openQuestions).toBe(0);
      });
    });

    describe("the change request's review state", () => {
      const state = (auth: string, runId = RUN, projectId = P) =>
        request(app())
          .get(`/api/projects/${projectId}/analyses/${runId}/review-state`)
          .set("Authorization", auth);

      it("is empty before any review", async () => {
        const res = await state(ANA());
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ review: null, assignedToMe: null });
      });

      it("shows the reviewer their assignment and the requester the review", async () => {
        await db.reviewRequest.create({
          data: {
            id: "rev-2343",
            projectId: P,
            title: "Sign off checkout",
            status: "in_review",
            requestedById: "u-ana",
            items: { create: [{ requirementId: "req-1", pinnedVersion: 1 }] },
            assignments: { create: [{ reviewerId: "u-rev", decision: "pending" }] },
          },
        });
        const reviewer = await state(REV());
        expect(reviewer.body.data).toEqual({
          review: {
            id: "rev-2343",
            title: "Sign off checkout",
            status: "in_review",
            requestedByMe: false,
          },
          assignedToMe: { id: "rev-2343", title: "Sign off checkout" },
        });
        const requester = await state(ANA());
        expect(requester.body.data.review).toMatchObject({
          status: "in_review",
          requestedByMe: true,
        });
        expect(requester.body.data.assignedToMe).toBeNull();
      });

      it("shows the requester a rejection, and the reviewer no longer has it waiting", async () => {
        await db.reviewRequest.update({
          where: { id: "rev-2343" },
          data: { status: "rejected", decidedAt: new Date() },
        });
        await db.reviewerAssignment.updateMany({
          where: { reviewRequestId: "rev-2343" },
          data: { decision: "rejected" },
        });
        const requester = await state(ANA());
        expect(requester.body.data.review).toMatchObject({
          id: "rev-2343",
          status: "rejected",
          requestedByMe: true,
        });
        expect((await state(REV())).body.data.assignedToMe).toBeNull();
      });

      it("never answers for a run of another project", async () => {
        expect((await state(ANA(), RUN_X, P)).status).toBe(404);
        expect((await state(OUT(), RUN, P)).status).toBe(404);
      });
    });
  },
);
