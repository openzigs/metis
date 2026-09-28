/**
 * #334 — `/api/run-reviews` is mounted outside `/api/projects`.
 * `GET /:runId` returned any run's stored PR review, and `POST /` started a run
 * bound to (and billed against) whatever `projectId` the body named — its
 * budget 429 even disclosed that project's spend — with no check on the
 * caller's access to the project.
 *
 * TODAY `pr.review` and `pr.review.read` are held by the `admin` role only
 * (`packages/shared/src/rbac.ts`), and admins bypass the project check by
 * design, so the ROLE gate alone keeps a non-admin out. The project check is
 * the object-level rule that must hold the moment either permission is granted
 * to another role. To reach it at all, this file widens ONLY the role gate for
 * the two `pr.review*` permissions (to any authenticated caller); everything
 * else is real — the router, `assertProjectAccess`, JWTs from `issueTokens`,
 * and a SQLite database built from the migration chain. The first test pins
 * the real role gate so the widening can never be mistaken for the product.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission } from "@metis/shared";
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
// The ONE widening: exactly `pr.review` and `pr.review.read` pass for any
// authenticated caller. Every other permission goes through the real middleware.
const WIDENED = new Set(["pr.review", "pr.review.read"]);
vi.mock("../src/middleware/require-permission.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/middleware/require-permission.js")>();
  return {
    requirePermission: (permission: string) =>
      WIDENED.has(permission)
        ? (req: express.Request, _res: express.Response, next: express.NextFunction) =>
            req.user ? next() : next(new Error("unauthenticated"))
        : real.requirePermission(permission as never),
  };
});

const { runReviewsRouter } = await import("../src/routes/run-reviews.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

type Role = "admin" | "coordinator";

const PA = "proj-a-0334rr";
const PB = "proj-b-0334rr";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#334 — /api/run-reviews checks the caller's access to the run's / body's project",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const token = (userId: string, role: Role, workspaces: string[]) =>
      issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
    let ADMIN = "";
    let A = "";
    let B = "";

    // Budget refuses every run, so a caller who passes the access check gets
    // the 429 and no judge / GitHub call is ever made.
    const budgetCheck = vi.fn(async () => ({
      allowed: false,
      capCents: 100,
      spentCents: 4242,
      resetAt: new Date("2026-10-01T00:00:00Z"),
    }));
    const judge = { evaluate: vi.fn(async () => "{}") };
    const octokit = { pulls: { createReview: vi.fn() } };

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use(
        "/api/run-reviews",
        runReviewsRouter({
          judge,
          octokit: octokit as never,
          budget: { check: budgetCheck } as never,
        }),
      );
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (url: string, bearer: string) =>
      request(app()).get(url).set("Authorization", `Bearer ${bearer}`);
    const trigger = (projectId: string, bearer: string) =>
      request(app())
        .post("/api/run-reviews")
        .set("Authorization", `Bearer ${bearer}`)
        .send({ projectId, owner: "o", repo: "r", prNumber: 7 });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("334-run-reviews-project-access");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-admin", "u-a", "u-b"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of ["ws-a", "ws-b"]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      await db.workspaceMember.create({ data: { workspaceId: "ws-a", userId: "u-a" } });
      await db.workspaceMember.create({ data: { workspaceId: "ws-b", userId: "u-b" } });
      for (const [id, ws] of [
        [PA, "ws-a"],
        [PB, "ws-b"],
      ]) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "u-admin", workspaceId: ws },
        });
      }
      const review = { kind: "pr_review", result: { verdict: "secret-review-a" } };
      await db.agentRun.create({ data: { id: "run-a", sessionId: "s-a", projectId: PA } });
      await db.agentRunStep.create({
        data: { runId: "run-a", ord: 0, kind: "tool_result", content: JSON.stringify(review) },
      });
      await db.agentRun.create({ data: { id: "run-system", sessionId: "s-sys", projectId: null } });

      ADMIN = token("u-admin", "admin", []);
      A = token("u-a", "coordinator", ["ws-a"]);
      B = token("u-b", "coordinator", ["ws-b"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => budgetCheck.mockClear());

    it("the real role map grants pr.review / pr.review.read to admin only (why the gate is widened here)", () => {
      for (const p of ["pr.review", "pr.review.read"] as const) {
        expect(hasPermission("admin", p)).toBe(true);
        for (const role of ["coordinator", "developer", "reader"] as const) {
          expect(hasPermission(role, p)).toBe(false);
        }
      }
    });

    describe("GET /api/run-reviews/:runId", () => {
      it("a cross-workspace caller gets the unknown-id 404 and no review", async () => {
        const res = await get("/api/run-reviews/run-a", B);
        const unknown = await get("/api/run-reviews/run-does-not-exist", B);
        expect(res.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(res.body).toEqual(unknown.body);
        expect(JSON.stringify(res.body)).not.toContain("secret-review");
      });

      it("the same-workspace caller and a system admin read the review", async () => {
        for (const who of [A, ADMIN]) {
          const res = await get("/api/run-reviews/run-a", who);
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect(res.body.data.review).toEqual({ verdict: "secret-review-a" });
        }
      });

      it("a run bound to no project is admin-only (fail closed)", async () => {
        const refused = await get("/api/run-reviews/run-system", A);
        const unknown = await get("/api/run-reviews/run-does-not-exist", A);
        expect(refused.status).toBe(404);
        expect(refused.body).toEqual(unknown.body);
        expect((await get("/api/run-reviews/run-system", ADMIN)).status).toBe(200);
      });
    });

    describe("POST /api/run-reviews", () => {
      it("a cross-workspace caller gets the unknown-project 404: no budget read, no run", async () => {
        const runsBefore = await db.agentRun.count();
        const res = await trigger(PA, B);
        const unknown = await trigger("proj-does-not-exist", B);
        expect(res.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(res.body).toEqual(unknown.body);
        expect(JSON.stringify(res.body)).not.toContain("4242");
        expect(budgetCheck).not.toHaveBeenCalled();
        expect(await db.agentRun.count()).toBe(runsBefore);
      });

      it("the same-workspace caller and a system admin pass the check (budget 429 here)", async () => {
        for (const who of [A, ADMIN]) {
          const res = await trigger(PA, who);
          expect(res.status, JSON.stringify(res.body)).toBe(429);
          expect(res.body.error).toBe("budget_exceeded");
        }
        expect(budgetCheck).toHaveBeenCalledTimes(2);
        expect(judge.evaluate).not.toHaveBeenCalled();
      });
    });
  },
);
