/**
 * #2345 — `POST /api/impact-analyses` with `analysisId`: an impact analysis
 * started from a change request. The server reads the change request's draft
 * and approved requirements itself (never the form's), refuses a change request
 * the caller cannot read or whose project is not in the run, links the run to
 * it, and lists and names it back (`GET /?analysisId=`, `GET /:id`).
 *
 * Workspace `ws1` holds project A (Alice and Bob are members); `ws2` holds
 * project B (Mallory). Real SQLite built by the migration chain, real router and
 * JWTs; the engine's fire-and-forget trigger is a double that writes the row
 * the real one writes (pending, its projects, its requirements, its link).
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  getPermissionsForRole,
  type AuthPayload,
  type ImpactAnalysisDetail,
  type ImpactAnalysisSummary,
  type RoleKey,
} from "@metis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TriggerImpactAnalysisInput } from "../src/lib/impact-analysis/impact-analysis-engine.js";
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
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
const triggerSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/impact-analysis/impact-analysis-engine.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/impact-analysis/impact-analysis-engine.js")
  >("../src/lib/impact-analysis/impact-analysis-engine.js");
  return { ...actual, triggerImpactAnalysis: triggerSpy };
});

const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { changeRequestRef } = await import("../src/lib/analysis/change-request-source.js");
const engine = await vi.importActual<
  typeof import("../src/lib/impact-analysis/impact-analysis-engine.js")
>("../src/lib/impact-analysis/impact-analysis-engine.js");

const WS1 = "ws1-2345";
const WS2 = "ws2-2345";
/** Workspace 3 holds project C: Carol reads only it; Bob reads it too. */
const WS3 = "ws3-2345";
const PC = "proj-c-2345";
const PA = "proj-a-2345";
const PB = "proj-b-2345";
/** Change requests: A's with requirements, A's with none, A's deleted, B's. */
const CR_A = "cr-a-2345-xxxx";
const CR_EMPTY = "cr-empty-2345";
const CR_DELETED = "cr-deleted-2345";
const CR_B = "cr-b-2345-xxxx";

const USERS: Record<string, { role: RoleKey; ws: string }> = {
  alice: { role: "coordinator", ws: WS1 },
  bob: { role: "coordinator", ws: WS1 },
  mallory: { role: "coordinator", ws: WS2 },
  carol: { role: "coordinator", ws: WS3 },
};
type Who = keyof typeof USERS;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2345 — an impact analysis started from a change request",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const userPayload = (who: Who): AuthPayload => ({
      userId: who,
      username: who,
      role: USERS[who].role,
      permissions: getPermissionsForRole(USERS[who].role),
      workspaces: [USERS[who].ws],
    });
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const bearer = (who: Who) => `Bearer ${issueTokens(userPayload(who)).accessToken}`;
    const post = (who: Who, body: object) =>
      request(app()).post("/api/impact-analyses").set("Authorization", bearer(who)).send(body);
    const get = (who: Who, path: string) =>
      request(app()).get(`/api/impact-analyses${path}`).set("Authorization", bearer(who));

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2345-change-request-impact");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.role.create({ data: { id: "role-coordinator", key: "coordinator", name: "c" } });
      for (const id of Object.keys(USERS)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.userRole.create({ data: { userId: id, roleId: "role-coordinator" } });
      }
      for (const ws of [WS1, WS2, WS3]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [userId, u] of Object.entries(USERS)) {
        await db.workspaceMember.create({ data: { workspaceId: u.ws, userId, role: "member" } });
      }
      await db.workspaceMember.create({
        data: { workspaceId: WS3, userId: "bob", role: "member" },
      });
      for (const [id, createdById, workspaceId] of [
        [PA, "alice", WS1],
        [PB, "mallory", WS2],
        [PC, "carol", WS3],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById, workspaceId, status: "active" },
        });
      }
      for (const [id, projectId, title, deleted] of [
        [CR_A, PA, "Password reset by email", false],
        [CR_EMPTY, PA, "Nothing yet", false],
        [CR_DELETED, PA, "Gone", true],
        [CR_B, PB, "Billing export", false],
      ] as const) {
        await db.analysis.create({
          data: {
            id,
            projectId,
            title,
            startedById: "alice",
            status: "completed",
            ...(deleted ? { deletedAt: new Date() } : {}),
          },
        });
      }
      // CR_A: two draft, one approved, one with no status, one rejected, one deferred, one deleted.
      const reqs: Array<[string, string, string, string | null, boolean]> = [
        ["req-a1-2345", CR_A, PA, "draft", false],
        ["req-a2-2345", CR_A, PA, "approved", false],
        ["req-a3-2345", CR_A, PA, null, false],
        ["req-a4-2345", CR_A, PA, "rejected", false],
        ["req-a5-2345", CR_A, PA, "deferred", false],
        ["req-a6-2345", CR_A, PA, "draft", true],
        ["req-del-2345", CR_DELETED, PA, "draft", false],
        ["req-b1-2345", CR_B, PB, "approved", false],
      ];
      let t = Date.parse("2026-11-01T00:00:00Z");
      for (const [id, analysisId, projectId, reviewStatus, deleted] of reqs) {
        await db.requirement.create({
          data: {
            id,
            projectId,
            analysisId,
            title: `Requirement ${id}`,
            body: "The body.",
            reviewStatus,
            createdAt: new Date((t += 1000)),
            ...(deleted ? { deletedAt: new Date() } : {}),
          },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    let started = Date.parse("2026-11-10T00:00:00Z");
    beforeEach(() => {
      triggerSpy.mockReset();
      // The row the real trigger writes, so the list and detail read it back.
      triggerSpy.mockImplementation(async (input: TriggerImpactAnalysisInput) => {
        const row = await db.impactAnalysis.create({
          data: {
            status: "pending",
            startedById: input.actorId,
            startedAt: new Date((started += 60_000)),
            requirementIds: JSON.stringify(input.requirementIds ?? []),
            sourceAnalysisId: input.sourceAnalysisId ?? null,
            projects: { create: input.projectIds.map((projectId) => ({ projectId })) },
          },
        });
        return { id: row.id, status: row.status };
      });
    });

    it("reads the change request's draft and approved requirements itself, in order, and links the run", async () => {
      const res = await post("bob", { analysisId: CR_A, projectIds: [PA] });
      expect(res.status).toBe(202);
      expect(triggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          projectIds: [PA],
          requirementIds: ["req-a1-2345", "req-a2-2345", "req-a3-2345"],
          sourceAnalysisId: CR_A,
          text: null,
          documentId: null,
        }),
        expect.anything(),
      );
      const row = await db.impactAnalysis.findUnique({ where: { id: res.body.data.id } });
      expect(row?.sourceAnalysisId).toBe(CR_A);
    });

    it("refuses a change request the form pairs with requirements, text or a document", async () => {
      for (const extra of [
        { requirementIds: ["req-a1-2345"] },
        { text: "Something typed" },
        { documentId: "doc-x" },
      ]) {
        const res = await post("bob", { analysisId: CR_A, projectIds: [PA], ...extra });
        expect(res.status).toBe(400);
      }
      expect(triggerSpy).not.toHaveBeenCalled();
    });

    it("refuses another project's change request, unreadable, unknown or deleted ones alike (404)", async () => {
      // Mallory's change request, named in a run over Bob's own project.
      const other = await post("bob", { analysisId: CR_B, projectIds: [PA] });
      expect(other.status).toBe(404);
      for (const id of ["cr-nope-2345", CR_DELETED]) {
        const res = await post("bob", { analysisId: id, projectIds: [PA] });
        expect(res.status).toBe(404);
        expect(res.body.error).toEqual(other.body.error);
      }
      // A project the caller cannot read is refused before the change request is read.
      expect((await post("bob", { analysisId: CR_B, projectIds: [PB] })).status).toBe(403);
      expect(triggerSpy).not.toHaveBeenCalled();
    });

    it("says a change request with no requirement to check has none (400)", async () => {
      const res = await post("bob", { analysisId: CR_EMPTY, projectIds: [PA] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("NO_REQUIREMENTS");
      expect(triggerSpy).not.toHaveBeenCalled();
    });

    it("lists a change request's runs newest first, names it on the detail, and hides both from a non-reader", async () => {
      const first = (await post("bob", { analysisId: CR_A, projectIds: [PA] })).body.data.id;
      const second = (await post("alice", { analysisId: CR_A, projectIds: [PA] })).body.data.id;
      // A run of the same project NOT started from the change request.
      const unrelated = (await post("bob", { text: "x", projectIds: [PA] })).body.data.id;

      const list = await get("bob", `?analysisId=${CR_A}`);
      expect(list.status).toBe(200);
      const ids = (list.body.data as ImpactAnalysisSummary[]).map((r) => r.id);
      expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
      expect(ids).not.toContain(unrelated);
      expect(
        (list.body.data as ImpactAnalysisSummary[]).every((r) => r.sourceAnalysisId === CR_A),
      ).toBe(true);
      // The project list still has both, and each says where it came from.
      const all = (await get("bob", `?projectId=${PA}`)).body.data as ImpactAnalysisSummary[];
      expect(all.find((r) => r.id === unrelated)?.sourceAnalysisId).toBeNull();

      const detail = await get("bob", `/${second}`);
      expect(detail.status).toBe(200);
      expect((detail.body.data as ImpactAnalysisDetail).changeRequest).toEqual({
        id: CR_A,
        projectId: PA,
        title: "Password reset by email",
      });
      expect((await get("bob", `/${unrelated}`)).body.data.changeRequest).toBeNull();

      // Mallory cannot read project A: neither the list nor the run.
      expect((await get("mallory", `?analysisId=${CR_A}`)).body.data).toEqual([]);
      expect((await get("mallory", `/${second}`)).status).toBe(404);
      expect((await get("bob", `?analysisId=${"x".repeat(65)}`)).status).toBe(400);
    });

    it("lists nothing to a reader of only a project co-selected in a run started from the change request", async () => {
      // Bob starts a run from project A's change request and adds project C.
      const run = (await post("bob", { analysisId: CR_A, projectIds: [PA, PC] })).body.data.id;
      // Carol reads C only: the run is hers to see by project, the change request is not.
      const byProject = (await get("carol", `?projectId=${PC}`)).body
        .data as ImpactAnalysisSummary[];
      expect(byProject.map((r) => r.id)).toContain(run);
      const byChangeRequest = await get("carol", `?analysisId=${CR_A}`);
      expect(byChangeRequest.status).toBe(200);
      expect(byChangeRequest.body.data).toEqual([]);
      // The same answer as an unknown change request.
      expect((await get("carol", "?analysisId=cr-nope-2345")).body.data).toEqual([]);
      // Bob reads A: he still sees it.
      const forBob = (await get("bob", `?analysisId=${CR_A}`)).body.data as ImpactAnalysisSummary[];
      expect(forBob.map((r) => r.id)).toContain(run);
    });

    it("names a change request back only among the projects it is given", async () => {
      expect(await changeRequestRef(CR_A, [PA, PC])).toEqual({
        id: CR_A,
        projectId: PA,
        title: "Password reset by email",
      });
      // Projects that do not include the change request's own: it is not named.
      expect(await changeRequestRef(CR_A, [PB, PC])).toBeNull();
      expect(await changeRequestRef(CR_A, [])).toBeNull();
      expect(await changeRequestRef(CR_DELETED, [PA])).toBeNull();
      expect(await changeRequestRef(null, [PA])).toBeNull();
    });

    it("the real trigger stores the change request it was started from", async () => {
      const create = vi.fn(async () => ({ id: "ia-real", status: "pending" }));
      const fakePrisma = {
        impactAnalysis: {
          create,
          update: vi.fn(),
          findUnique: vi.fn(async () => null),
          findFirst: vi.fn(async () => null),
        },
      };
      await engine.triggerImpactAnalysis(
        {
          projectIds: [PA],
          requirementIds: ["req-a1-2345"],
          sourceAnalysisId: CR_A,
          actorId: "bob",
        },
        { prisma: fakePrisma as never },
      );
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({ sourceAnalysisId: CR_A }),
      });
      create.mockClear();
      await engine.triggerImpactAnalysis(
        { projectIds: [PA], text: "x", actorId: "bob" },
        { prisma: fakePrisma as never },
      );
      expect(create.mock.calls[0]).toBeDefined();
      expect(
        (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data,
      ).not.toHaveProperty("sourceAnalysisId");
    });
  },
);
