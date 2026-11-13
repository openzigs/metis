/**
 * #2436 — direct approval needs `requirement.approve`, and is maker-checker.
 *
 * Through the REAL requirement routes (`PUT /api/requirements/:id`, the list and
 * the card; `PATCH /api/analyses/:id/requirements/:reqId`, the API) and the REAL
 * review routes, against a REAL SQLite database built from the migration chain,
 * with real JWTs. Every outcome is read back from the database.
 *
 * Maker-checker: by default the author of a requirement (whoever wrote or edited
 * its wording, or created it) cannot approve it directly, and the requester of a
 * review cannot sign it off. The project's `allowSelfApproval` lets a solo
 * analyst do both, with `requirement.approve`, and the audit log says so.
 *
 * The role matrix for both write routes (every role, an edit and a verdict) is
 * `requirement-write-permission-1566.sqlite.test.ts`; a non-admin analyst
 * granted `requirement.approve` without `project.update` is
 * `requirement-approve-granted-2436.sqlite.test.ts`.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type RoleKey } from "@metis/shared";
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
    resolveDatabaseProvider: () => "sqlite" as const,
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => null }));

const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { projectReviewsRouter, reviewsRouter } = await import("../src/routes/reviews.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { audit } = await import("../src/lib/audit/audit-service.js");
const { SELF_APPROVAL_FORBIDDEN_MESSAGE } =
  await import("../src/lib/requirements/requirement-version-service.js");

const WORKSPACE = "ws-2436";
const PROJECT = "proj-2436";
const ANALYSIS = "ana-2436";
/** Two coordinators (maker and checker), an admin and a developer analyst. */
const MAKER = "u-2436-maker";
const CHECKER = "u-2436-checker";
const ADMIN = "u-2436-admin";
const DEV = "u-2436-dev";
const ROLE: Record<string, RoleKey> = {
  [MAKER]: "coordinator",
  [CHECKER]: "coordinator",
  [ADMIN]: "admin",
  [DEV]: "developer",
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2436 — requirement.approve and maker-checker approval",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use("/api/analyses", initAnalysisRouter().topLevel);
      a.use("/api/projects/:projectId/reviews", projectReviewsRouter());
      a.use("/api/reviews", reviewsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const bearer = (userId: string) =>
      `Bearer ${
        issueTokens({
          userId,
          username: userId,
          role: ROLE[userId]!,
          permissions: getPermissionsForRole(ROLE[userId]!),
          workspaces: [WORKSPACE],
        }).accessToken
      }`;
    const put = (userId: string, id: string, body: object) =>
      request(app()).put(`/api/requirements/${id}`).set("Authorization", bearer(userId)).send(body);
    const patch = (userId: string, id: string, body: object) =>
      request(app())
        .patch(`/api/analyses/${ANALYSIS}/requirements/${id}`)
        .set("Authorization", bearer(userId))
        .send(body);
    const approve = (userId: string, id: string) => put(userId, id, { reviewStatus: "approved" });
    const row = (id: string) => db.requirement.findUniqueOrThrow({ where: { id } });
    const versionsOf = (id: string) =>
      db.requirementVersion.findMany({ where: { requirementId: id }, orderBy: { version: "asc" } });
    const allowSelfApproval = (on: boolean) =>
      db.project.update({ where: { id: PROJECT }, data: { allowSelfApproval: on } });

    /** A requirement as an analysis run writes it: no human author. */
    const makeRequirement = async (reviewStatus: string | null = "draft") => {
      seq += 1;
      return db.requirement.create({
        data: {
          id: `req-2436-${seq}`,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: `Requirement ${seq}`,
          body: "The original body",
          reviewStatus,
          version: 0,
        },
      });
    };
    /** `userId` wrote its wording, through the Edit dialog's route. */
    const authoredBy = async (userId: string) => {
      const req = await makeRequirement();
      const res = await put(userId, req.id, { body: `Reworded by ${userId}` });
      expect(res.status).toBe(200);
      return row(req.id);
    };
    const expectSelfApprovalRefused = (res: request.Response) => {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({
        code: "SELF_APPROVAL_FORBIDDEN",
        message: SELF_APPROVAL_FORBIDDEN_MESSAGE,
      });
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2436-requirement-approve");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WORKSPACE, name: "ws", slug: WORKSPACE } });
      for (const id of [MAKER, CHECKER, ADMIN, DEV]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.workspaceMember.create({
          data: { workspaceId: WORKSPACE, userId: id, role: "member" },
        });
      }
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: ADMIN,
          workspaceId: WORKSPACE,
        },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: MAKER, status: "completed" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      vi.mocked(audit).mockClear();
      await allowSelfApproval(false);
    });

    describe("direct approval (the list, the card and the API)", () => {
      it("a project does not allow self-approval until someone turns it on", async () => {
        const fresh = await db.project.create({
          data: {
            id: "proj-2436-fresh",
            name: "fresh",
            slug: "proj-2436-fresh",
            createdById: ADMIN,
          },
        });
        expect(fresh.allowSelfApproval).toBe(false);
      });

      it("the author of a requirement cannot approve it; a colleague can", async () => {
        const req = await authoredBy(MAKER);

        expectSelfApprovalRefused(await approve(MAKER, req.id));
        expect(await row(req.id)).toEqual(req);

        const res = await approve(CHECKER, req.id);
        expect(res.status).toBe(200);
        expect((await row(req.id)).reviewStatus).toBe("approved");
      });

      it("the API route refuses the author the same way", async () => {
        const req = await authoredBy(MAKER);

        expectSelfApprovalRefused(await patch(MAKER, req.id, { reviewStatus: "approved" }));
        expect(await row(req.id)).toEqual(req);
        expect((await patch(CHECKER, req.id, { reviewStatus: "approved" })).status).toBe(200);
      });

      it("an admin who wrote it is its author too", async () => {
        const req = await authoredBy(ADMIN);
        expectSelfApprovalRefused(await approve(ADMIN, req.id));
        expect((await row(req.id)).reviewStatus).toBe("draft");
      });

      it("rewording and approving in one write is refused, and writes nothing", async () => {
        const req = await makeRequirement();

        expectSelfApprovalRefused(
          await put(CHECKER, req.id, { title: "Reworded", reviewStatus: "approved", version: 0 }),
        );
        expect(await row(req.id)).toEqual(req);
        expect(await versionsOf(req.id)).toHaveLength(0);
      });

      it("rewording an approved requirement while keeping it approved is refused", async () => {
        const req = await makeRequirement("approved");

        expectSelfApprovalRefused(
          await put(CHECKER, req.id, { body: "Quietly changed", reviewStatus: "approved" }),
        );
        expect(await row(req.id)).toEqual(req);
      });

      it("one who created it (promoted from a discussion) is its author", async () => {
        const req = await makeRequirement();
        await db.requirementVersion.create({
          data: {
            requirementId: req.id,
            version: 0,
            changedFields: JSON.stringify({
              __created: { from: null, to: "promoted-from-discussion" },
            }),
            actorId: MAKER,
          },
        });
        expectSelfApprovalRefused(await approve(MAKER, req.id));
      });

      it("a version row whose diff cannot be read counts as authored", async () => {
        const req = await makeRequirement();
        await db.requirementVersion.create({
          data: { requirementId: req.id, version: 1, changedFields: "not json", actorId: MAKER },
        });
        expectSelfApprovalRefused(await approve(MAKER, req.id));
      });

      it("changing only its priority or labels does not make someone its author", async () => {
        const req = await makeRequirement();
        expect((await put(MAKER, req.id, { priority: "high", labels: ["auth"] })).status).toBe(200);
        expect(await versionsOf(req.id)).toHaveLength(1);

        expect((await approve(MAKER, req.id)).status).toBe(200);
        expect((await row(req.id)).reviewStatus).toBe("approved");
      });

      it("a requirement the analysis wrote has no author: whoever ran it may approve it", async () => {
        const req = await makeRequirement();
        expect((await approve(MAKER, req.id)).status).toBe(200);
      });

      it("only approval is maker-checked: the author may reject their own requirement", async () => {
        const req = await authoredBy(MAKER);
        expect((await put(MAKER, req.id, { reviewStatus: "rejected" })).status).toBe(200);
        expect((await row(req.id)).reviewStatus).toBe("rejected");
      });

      it("with self-approval allowed the author approves, on both routes, and the audit says so", async () => {
        await allowSelfApproval(true);
        const viaPut = await authoredBy(MAKER);
        const viaPatch = await authoredBy(MAKER);
        vi.mocked(audit).mockClear();

        expect((await approve(MAKER, viaPut.id)).status).toBe(200);
        expect((await patch(MAKER, viaPatch.id, { reviewStatus: "approved" })).status).toBe(200);

        expect((await row(viaPut.id)).reviewStatus).toBe("approved");
        expect((await row(viaPatch.id)).reviewStatus).toBe("approved");
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "requirement.review_status.set",
            target: { type: "requirement", id: viaPut.id },
            metadata: { from: "draft", to: "approved", selfApproval: true },
          }),
        );
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "analysis.requirement.update",
            target: { type: "requirement", id: viaPatch.id },
            metadata: expect.objectContaining({ selfApproval: true }),
          }),
        );
      });

      it("an approval by someone else is not marked a self-approval", async () => {
        await allowSelfApproval(true);
        const req = await authoredBy(MAKER);
        vi.mocked(audit).mockClear();

        expect((await approve(CHECKER, req.id)).status).toBe(200);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "requirement.review_status.set",
            metadata: { from: "draft", to: "approved" },
          }),
        );
      });

      it("a self-approved rewording under an approval is audited even though the status stays", async () => {
        await allowSelfApproval(true);
        const req = await makeRequirement("approved");
        vi.mocked(audit).mockClear();

        const res = await put(MAKER, req.id, { body: "Mine now", reviewStatus: "approved" });
        expect(res.status).toBe(200);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "requirement.review_status.set",
            metadata: { from: "approved", to: "approved", selfApproval: true },
          }),
        );
      });

      it("a developer analyst has no requirement.approve, so self-approval does not help them", async () => {
        await allowSelfApproval(true);
        const req = await makeRequirement();
        const res = await approve(DEV, req.id);
        expect(res.status).toBe(403);
        expect(res.body.error).toMatchObject({
          code: "FORBIDDEN",
          message: "Requires permission requirement.approve",
        });
        expect(await row(req.id)).toEqual(req);
      });
    });

    describe("formal review: the requester does not sign off their own request", () => {
      const createReview = (userId: string, requirementId: string, reviewerIds: string[]) =>
        request(app())
          .post(`/api/projects/${PROJECT}/reviews`)
          .set("Authorization", bearer(userId))
          .send({ title: "Sign-off", reviewerIds, items: [{ requirementId }] });
      const reviewAction = (userId: string, reviewId: string, action: string, body = {}) =>
        request(app())
          .post(`/api/reviews/${reviewId}/${action}`)
          .set("Authorization", bearer(userId))
          .send(body);
      const selfReview = async (userId: string) => {
        const req = await makeRequirement();
        const created = await createReview(userId, req.id, [userId]);
        expect(created.status).toBe(201);
        const reviewId = created.body.data.id as string;
        expect((await reviewAction(userId, reviewId, "submit")).status).toBe(200);
        return { req, reviewId };
      };

      it("by default the requester cannot name themselves a reviewer", async () => {
        const req = await makeRequirement();
        const res = await createReview(MAKER, req.id, [MAKER]);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("SELF_REVIEW_FORBIDDEN");
        expect(await db.reviewRequest.count({ where: { requestedById: MAKER } })).toBe(0);
      });

      it("with self-approval allowed, a requester with requirement.approve signs off alone, audited", async () => {
        await allowSelfApproval(true);
        const { req, reviewId } = await selfReview(MAKER);

        const res = await reviewAction(MAKER, reviewId, "decision", { decision: "approved" });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ aggregate: "approved", status: "approved" });
        expect((await row(req.id)).reviewStatus).toBe("approved");

        const decision = await db.auditLog.findFirstOrThrow({
          where: { action: "review.decision", targetId: reviewId },
        });
        expect(JSON.parse(String(decision.metadata))).toMatchObject({
          decision: "approved",
          selfApproval: true,
        });
      });

      it("a colleague's decision is not marked a self-approval", async () => {
        const req = await makeRequirement();
        const created = await createReview(MAKER, req.id, [CHECKER]);
        const reviewId = created.body.data.id as string;
        await reviewAction(MAKER, reviewId, "submit");
        expect(
          (await reviewAction(CHECKER, reviewId, "decision", { decision: "approved" })).status,
        ).toBe(200);
        const decision = await db.auditLog.findFirstOrThrow({
          where: { action: "review.decision", targetId: reviewId },
        });
        expect(JSON.parse(String(decision.metadata))).not.toHaveProperty("selfApproval");
      });

      it("a developer cannot review their own request even where self-approval is allowed", async () => {
        await allowSelfApproval(true);
        const req = await makeRequirement();
        const res = await createReview(DEV, req.id, [DEV]);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("SELF_REVIEW_FORBIDDEN");
      });

      it("turning the setting off stops a self-review already in review", async () => {
        await allowSelfApproval(true);
        const { req, reviewId } = await selfReview(MAKER);
        await allowSelfApproval(false);

        const res = await reviewAction(MAKER, reviewId, "decision", { decision: "approved" });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("SELF_APPROVAL_FORBIDDEN");
        expect((await db.reviewRequest.findUniqueOrThrow({ where: { id: reviewId } })).status).toBe(
          "in_review",
        );
        expect((await row(req.id)).reviewStatus).toBe("draft");
      });

      it("a requester reviewing their own request may withdraw it, and revise it after rejecting it", async () => {
        await allowSelfApproval(true);
        const first = await selfReview(MAKER);
        const withdrawn = await reviewAction(MAKER, first.reviewId, "withdraw");
        expect(withdrawn.status).toBe(200);
        expect(withdrawn.body.data.status).toBe("draft");

        const second = await selfReview(MAKER);
        await reviewAction(MAKER, second.reviewId, "decision", { decision: "rejected" });
        const revised = await reviewAction(MAKER, second.reviewId, "revise");
        expect(revised.status).toBe(200);
        expect(revised.body.data.status).toBe("draft");
      });
    });
  },
);
