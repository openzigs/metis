/**
 * #1230 — approving or editing a requirement makes a reader BRD that lists the
 * approved requirements stale: every writer an analyst approves or edits
 * through asks the existing auto-update check (`checkIncrementalRegeneration`)
 * to look at the project's reader BRDs again, after its write has committed.
 *
 * That the check then sees the change is proven where the snapshot is built
 * (`generation-inputs.test.ts`: an approval or an edit moves the fingerprint)
 * and where documents are chosen (`incremental.test.ts`). Here: the real
 * routes and review service against a real migrated SQLite database, with
 * only the check itself, notifications and audit faked.
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
  return { db: null as unknown, check: vi.fn(), layout: vi.fn() };
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
vi.mock("../src/lib/reviews/notify.js", () => ({
  dispatchReviewSubmitted: vi.fn(),
  dispatchReviewDecision: vi.fn(),
}));
vi.mock("../src/lib/docs-gen/incremental.js", () => ({
  checkIncrementalRegeneration: state.check,
}));
vi.mock("../src/lib/docs-gen/brd-layout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/docs-gen/brd-layout.js")>()),
  readBrdLayoutSetting: state.layout,
}));

const { createReviewRequest, submitReview, recordDecision } =
  await import("../src/lib/reviews/review-service.js");
const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const PROJECT = "proj-1230";
const ANALYSIS = "ana-1230";
const REQUESTER = "u-1230-req";
const REVIEWER = "u-1230-rev";
const CHECKED = [PROJECT, undefined, { approvedRequirementsOnly: true }];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1230 — a requirement write marks reader BRDs for the auto-update check (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const makeRequirement = async (data: Record<string, unknown> = {}) => {
      seq += 1;
      const row = await db.requirement.create({
        data: {
          id: `req-1230-${seq}`,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: `Requirement ${seq}`,
          body: "The original body",
          ...data,
        },
      });
      return row.id;
    };
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use("/api/analyses", initAnalysisRouter().topLevel);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const token = () =>
      issueTokens({
        userId: REQUESTER,
        username: REQUESTER,
        role: "admin",
        permissions: [],
        workspaces: ["ws-1230"],
      }).accessToken;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1230-reader-brd-staleness");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of [REQUESTER, REVIEWER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-1230", name: "ws", slug: "ws-1230" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-1230", userId: REQUESTER, role: "owner" },
      });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: REQUESTER,
          workspaceId: "ws-1230",
        },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: REQUESTER, status: "completed" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      state.check.mockReset();
      state.check.mockResolvedValue(undefined);
      state.layout.mockReturnValue({ layout: "reader" });
    });

    it("approving on the Analysis page (PATCH) asks for the check", async () => {
      const id = await makeRequirement({ version: 1, reviewStatus: "draft" });
      const r = await request(app())
        .patch(`/api/analyses/${ANALYSIS}/requirements/${id}`)
        .set("Authorization", `Bearer ${token()}`)
        .send({ reviewStatus: "approved", version: 1 });
      expect(r.status).toBe(200);
      await vi.waitFor(() => expect(state.check).toHaveBeenCalledWith(...CHECKED));
    });

    it("editing an approved requirement (PUT) asks for the check", async () => {
      const id = await makeRequirement({ version: 0, reviewStatus: "approved" });
      const r = await request(app())
        .put(`/api/requirements/${id}`)
        .set("Authorization", `Bearer ${token()}`)
        .send({ title: "Renamed by the analyst", version: 0 });
      expect(r.status).toBe(200);
      await vi.waitFor(() => expect(state.check).toHaveBeenCalledWith(...CHECKED));
    });

    it("a write that changes nothing does not", async () => {
      const id = await makeRequirement({ version: 0, reviewStatus: "approved" });
      const put = await request(app())
        .put(`/api/requirements/${id}`)
        .set("Authorization", `Bearer ${token()}`)
        .send({ reviewStatus: "approved", version: 0 });
      expect(put.status).toBe(200);
      const patch = await request(app())
        .patch(`/api/analyses/${ANALYSIS}/requirements/${id}`)
        .set("Authorization", `Bearer ${token()}`)
        .send({ reviewStatus: "approved", version: 0 });
      expect(patch.status).toBe(200);
      // Let any stray post-response work run before asserting nothing ran.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(state.check).not.toHaveBeenCalled();
    });

    it("a review reaching its verdict asks for the check; a decision short of one does not", async () => {
      const id = await makeRequirement({ version: 0, reviewStatus: null });
      const created = (await createReviewRequest(REQUESTER, PROJECT, {
        title: "Sign-off",
        policy: "all",
        reviewerIds: [REVIEWER],
        items: [{ requirementId: id }],
      })) as { id: string };
      await submitReview(REQUESTER, created.id, false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(state.check).not.toHaveBeenCalled();
      await recordDecision(REVIEWER, created.id, "approved");
      expect(await db.requirement.findUniqueOrThrow({ where: { id } })).toMatchObject({
        reviewStatus: "approved",
      });
      await vi.waitFor(() => expect(state.check).toHaveBeenCalledWith(...CHECKED));
    });

    it("asks for nothing under the catalogue layout", async () => {
      state.layout.mockReturnValue({ layout: "catalogue" });
      const id = await makeRequirement({ version: 1, reviewStatus: "draft" });
      const r = await request(app())
        .patch(`/api/analyses/${ANALYSIS}/requirements/${id}`)
        .set("Authorization", `Bearer ${token()}`)
        .send({ reviewStatus: "approved", version: 1 });
      expect(r.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(state.check).not.toHaveBeenCalled();
    });
  },
);
