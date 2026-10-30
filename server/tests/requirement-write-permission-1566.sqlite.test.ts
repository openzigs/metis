/**
 * #1566 — both requirement write routes enforce the same permission.
 *
 * The Analysis page's Edit / Approve / Reject go through
 * `PUT /api/requirements/:id`, gated by `project.update`. The sibling
 * `PATCH /api/analyses/:id/requirements/:reqId` parses the same patch and writes
 * through the same service, but was gated only by `analysis.run`, which
 * `developer` holds — so a developer could edit, approve or reject a
 * requirement over the API that the PUT route refuses them.
 *
 * Every role is driven through both routes, for a content edit and for a
 * review-status change, against a real SQLite database built from the
 * migration chain, with real JWTs and the real permission middleware. Each
 * outcome is read back from the database, so a 403 is proven to have written
 * nothing and a 200 to have written what it said.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import type { RoleKey } from "@metis/shared";
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
    resolveDatabaseProvider: () => "sqlite" as const,
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WORKSPACE = "ws-1566";
const PROJECT = "proj-1566";
const ANALYSIS = "ana-1566";

/** Each role, and whether it may write a requirement (`project.update`). */
const ROLES: { role: RoleKey; mayWrite: boolean }[] = [
  { role: "reader", mayWrite: false },
  { role: "developer", mayWrite: false },
  { role: "coordinator", mayWrite: true },
  { role: "admin", mayWrite: true },
];

/** The two routes that write a requirement, each as the client calls it. */
const ROUTES = [
  {
    name: "PUT /api/requirements/:id",
    send: (app: express.Express, id: string) => request(app).put(`/api/requirements/${id}`),
  },
  {
    name: "PATCH /api/analyses/:id/requirements/:reqId",
    send: (app: express.Express, id: string) =>
      request(app).patch(`/api/analyses/${ANALYSIS}/requirements/${id}`),
  },
] as const;

/** A content edit and a review-status change — the Edit and Approve/Reject buttons. */
const WRITES = [
  { name: "a content edit", body: { title: "Renamed" }, field: "title", to: "Renamed" },
  {
    name: "a review-status change",
    body: { reviewStatus: "approved" },
    field: "reviewStatus",
    to: "approved",
  },
] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1566 — requirement writes need project.update on both requirement write routes",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use("/api/analyses", initAnalysisRouter().topLevel);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const userId = (role: RoleKey) => `u-1566-${role}`;
    const tokenFor = (role: RoleKey) =>
      issueTokens({
        userId: userId(role),
        username: userId(role),
        role,
        permissions: [],
        workspaces: [WORKSPACE],
      }).accessToken;

    const makeRequirement = async () => {
      seq += 1;
      const row = await db.requirement.create({
        data: {
          id: `req-1566-${seq}`,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: `Requirement ${seq}`,
          body: "The original body",
          reviewStatus: "draft",
          version: 0,
        },
      });
      return row;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1566-requirement-write-permission");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WORKSPACE, name: "ws", slug: WORKSPACE } });
      for (const { role } of ROLES) {
        const id = userId(role);
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        // Every role is a member of the project's workspace, so the only thing
        // that differs between them is the role the token carries.
        await db.workspaceMember.create({
          data: { workspaceId: WORKSPACE, userId: id, role: "member" },
        });
      }
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: userId("admin"),
          workspaceId: WORKSPACE,
        },
      });
      await db.analysis.create({
        data: {
          id: ANALYSIS,
          projectId: PROJECT,
          startedById: userId("admin"),
          status: "completed",
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    for (const route of ROUTES) {
      describe(route.name, () => {
        for (const { role, mayWrite } of ROLES) {
          for (const write of WRITES) {
            it(`${mayWrite ? "lets" : "refuses"} ${role} ${write.name}`, async () => {
              const before = await makeRequirement();

              const res = await route
                .send(app(), before.id)
                .set("Authorization", `Bearer ${tokenFor(role)}`)
                .send({ ...write.body, version: before.version });

              const after = await db.requirement.findUniqueOrThrow({ where: { id: before.id } });
              if (mayWrite) {
                expect(res.status).toBe(200);
                expect(after[write.field]).toBe(write.to);
              } else {
                expect(res.status).toBe(403);
                expect(res.body.error).toMatchObject({
                  code: "FORBIDDEN",
                  message: "Requires permission project.update",
                });
                // Nothing written: the row is exactly as it was created.
                expect(after).toEqual(before);
              }
            });
          }
        }
      });
    }
  },
);
