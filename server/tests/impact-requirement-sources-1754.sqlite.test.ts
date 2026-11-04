/**
 * #1754 — `POST /api/impact-analyses` with `requirementIds`: the run reads each
 * requirement's text and stored code links, so the caller must be able to read
 * every requirement, not only the run's projects (no IDOR). An unreadable
 * requirement is refused with the project check's own error, and for a member a
 * nonexistent or deleted one gets that same answer (no existence oracle).
 *
 * Workspace `ws1` holds project A (Alice and Bob are members); `ws2` holds
 * project B (Mallory). Project L is legacy (no workspace) and so open to every
 * authenticated user. Ada is a system admin.
 *
 * Real SQLite built by the migration chain, real routers and JWTs; the impact
 * engine's fire-and-forget trigger is a double, except in the last block, which
 * reads a persisted item back through `GET /api/impact-analyses/:id`.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const { impactAnalysisRouter, impactRunDeps } = await import("../src/routes/impact-analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS1 = "ws1-1754";
const WS2 = "ws2-1754";
const PA = "proj-a-1754";
const PB = "proj-b-1754";
const PL = "proj-legacy-1754";

const USERS: Record<string, { role: RoleKey; ws: string }> = {
  alice: { role: "coordinator", ws: WS1 },
  bob: { role: "coordinator", ws: WS1 },
  mallory: { role: "coordinator", ws: WS2 },
  ada: { role: "admin", ws: WS2 },
};
type Who = keyof typeof USERS;

const REQ = {
  a: "req-a-1754-xxxxx",
  a2: "req-a2-1754-xxxx",
  b: "req-b-1754-xxxxx",
  l: "req-l-1754-xxxxx",
  deleted: "req-del-1754-xxx",
  missing: "req-nope-1754-xx",
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1754 — an impact run about stored requirements needs read access to every one",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let runFromReqA = "";
    let runFromReqB = "";

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
    const post = (path: string, who: Who, body: object = {}) =>
      request(app()).post(path).set("Authorization", bearer(who)).send(body);
    const start = (who: Who, projectIds: string[], requirementIds: string[]) =>
      post("/api/impact-analyses", who, { projectIds, requirementIds });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1754-impact-requirement-sources");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const key of ["coordinator", "admin"]) {
        await db.role.create({ data: { id: `role-${key}`, key, name: key } });
      }
      for (const [id, u] of Object.entries(USERS)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.userRole.create({ data: { userId: id, roleId: `role-${u.role}` } });
      }
      for (const ws of [WS1, WS2]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [userId, u] of Object.entries(USERS)) {
        await db.workspaceMember.create({ data: { workspaceId: u.ws, userId, role: "member" } });
      }
      for (const [id, createdById, workspaceId] of [
        [PA, "alice", WS1],
        [PB, "mallory", WS2],
        [PL, "mallory", null],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById, workspaceId, status: "active" },
        });
        await db.analysis.create({
          data: { id: `an-${id}`, projectId: id, startedById: createdById, status: "completed" },
        });
      }
      for (const [id, projectId, deleted] of [
        [REQ.a, PA, false],
        [REQ.a2, PA, false],
        [REQ.b, PB, false],
        [REQ.l, PL, false],
        [REQ.deleted, PA, true],
      ] as const) {
        await db.requirement.create({
          data: {
            id,
            projectId,
            analysisId: `an-${projectId}`,
            title: `Requirement ${id}`,
            body: "The body.",
            ...(deleted ? { deletedAt: new Date() } : {}),
          },
        });
      }
      for (const [reqId, startedById] of [
        [REQ.a, "alice"],
        [REQ.b, "alice"],
      ] as const) {
        const ia = await db.impactAnalysis.create({
          data: { status: "completed", startedById, requirementIds: JSON.stringify([reqId]) },
        });
        await db.impactAnalysisProject.create({ data: { analysisId: ia.id, projectId: PA } });
        await db.impactItem.create({
          data: {
            impactAnalysisId: ia.id,
            projectId: PA,
            requirementId: reqId === REQ.a ? REQ.a : null,
            seedEvidence: JSON.stringify({
              storedLinks: { used: 1, stale: 1 },
              editCandidates: [{ filePath: "src/orders.ts", channels: ["stored-link"] }],
            }),
          },
        });
        if (reqId === REQ.a) runFromReqA = ia.id;
        else runFromReqB = ia.id;
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      triggerSpy.mockReset();
      triggerSpy.mockResolvedValue({ id: "new-run", status: "pending" });
    });

    describe("POST /api/impact-analyses", () => {
      it("passes a member's own requirements to the run, deduplicated", async () => {
        const res = await start("bob", [PA], [REQ.a, REQ.a2, REQ.a]);
        expect(res.status).toBe(202);
        expect(triggerSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            requirementIds: [REQ.a, REQ.a2],
            text: null,
            projectIds: [PA],
          }),
          expect.anything(),
        );
      });

      it("lets anyone use a legacy project's requirement", async () => {
        expect((await start("bob", [PA], [REQ.l])).status).toBe(202);
      });

      it("refuses another workspace's requirement with the project check's own error", async () => {
        const viaRequirement = await start("bob", [PA], [REQ.a, REQ.b]);
        const viaProject = await post("/api/impact-analyses", "bob", {
          projectIds: [PB],
          text: "x",
        });
        expect(viaRequirement.status).toBe(403);
        expect(viaRequirement.body.error).toEqual(viaProject.body.error);
        expect(triggerSpy).not.toHaveBeenCalled();
      });

      it("answers a missing or deleted requirement exactly as an unreadable one, for a member", async () => {
        const unreadable = await start("bob", [PA], [REQ.b]);
        for (const id of [REQ.missing, REQ.deleted]) {
          const res = await start("bob", [PA], [id]);
          expect(res.status).toBe(403);
          expect(res.body.error).toEqual(unreadable.body.error);
        }
        expect(triggerSpy).not.toHaveBeenCalled();
      });

      it("keeps the admin bypass; an admin is told a missing requirement is missing", async () => {
        expect((await start("ada", [PA], [REQ.a, REQ.b])).status).toBe(202);
        const missing = await start("ada", [PA], [REQ.missing]);
        expect(missing.status).toBe(404);
        expect(missing.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
      });

      it("rejects an unbounded list before any lookup", async () => {
        const ids = Array.from({ length: 51 }, (_, i) => `req-many-${String(i).padStart(4, "0")}`);
        const res = await start("bob", [PA], ids);
        expect(res.status).toBe(400);
        expect(triggerSpy).not.toHaveBeenCalled();
      });
    });

    describe("POST /api/impact-analyses/:id/rerun", () => {
      it("re-runs a run about a stored requirement with the same requirement", async () => {
        const res = await post(`/api/impact-analyses/${runFromReqA}/rerun`, "bob");
        expect(res.status).toBe(202);
        expect(triggerSpy).toHaveBeenCalledWith(
          expect.objectContaining({ requirementIds: [REQ.a], rerunOfId: runFromReqA }),
          expect.anything(),
        );
      });

      it("refuses a re-run that would re-read a requirement the caller cannot read", async () => {
        const res = await post(`/api/impact-analyses/${runFromReqB}/rerun`, "bob");
        expect(res.status).toBe(403);
        expect(triggerSpy).not.toHaveBeenCalled();
      });
    });

    describe("GET /api/impact-analyses/:id", () => {
      it("returns the stored seed evidence on the item", async () => {
        const res = await request(app())
          .get(`/api/impact-analyses/${runFromReqA}`)
          .set("Authorization", bearer("alice"));
        expect(res.status).toBe(200);
        expect(res.body.data.items[0].seedEvidence).toEqual({
          storedLinks: { used: 1, stale: 1 },
          editCandidates: [{ filePath: "src/orders.ts", channels: ["stored-link"] }],
        });
      });
    });

    describe("impactRunDeps", () => {
      const prior = process.env.IMPACT_STORED_LINK_SEEDS;
      afterEach(() => {
        if (prior === undefined) delete process.env.IMPACT_STORED_LINK_SEEDS;
        else process.env.IMPACT_STORED_LINK_SEEDS = prior;
      });

      it("turns the stored-link channel on only when IMPACT_STORED_LINK_SEEDS is", () => {
        delete process.env.IMPACT_STORED_LINK_SEEDS;
        expect("storedLinkSeeds" in impactRunDeps("alice", [PA])).toBe(false);
        process.env.IMPACT_STORED_LINK_SEEDS = "true";
        expect(impactRunDeps("alice", [PA]).storedLinkSeeds).toBe(true);
      });
    });
  },
);
