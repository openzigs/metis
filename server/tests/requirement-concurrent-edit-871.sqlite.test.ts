/**
 * #871 — two concurrent edits carrying the SAME version must not both succeed.
 *
 * The optimistic-lock middleware compares the body's `version` with a read that
 * runs BEFORE the write transaction opens. Two edits based on version N both
 * passed that read, then both committed: the second silently overwrote the
 * first, each bumped the version, and nobody got a 409.
 *
 * The race is made deterministic here: the database handle the routes see holds
 * every interactive `$transaction` at its start until BOTH requests have
 * reached it — i.e. until both have already passed the middleware's check. That
 * is exactly the interleaving the issue describes. Expected: one 200, one 409
 * `VERSION_CONFLICT` with the lock's field diff, the winner's edit intact, one
 * history row.
 *
 * Proven through the real routers (`PUT /api/requirements/:id` and
 * `PATCH /api/analyses/:id/requirements/:reqId`) against a real SQLite database
 * built from the migration chain. Postgres, where the two transactions really
 * can interleave inside the transaction, is covered by
 * `requirement-concurrent-edit-871-postgres.integration.test.ts`.
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
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const PROJECT = "proj-871";
const ANALYSIS = "ana-871";

/**
 * Wrap a client so its next `parties` interactive transactions each wait at
 * their start until all of them have arrived. Everything else passes through.
 */
function withTransactionBarrier(db: PrismaClient, parties: number): PrismaClient {
  let arrived = 0;
  let release!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "$transaction") {
        return async (...args: unknown[]) => {
          if (typeof args[0] === "function") {
            arrived += 1;
            if (arrived === parties) release();
            await allArrived;
          }
          return (target.$transaction as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#871 — concurrent requirement edits with the same version",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ADMIN = "";
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

    const makeRequirement = async () => {
      seq += 1;
      const row = await db.requirement.create({
        data: {
          id: `req-871-${seq}`,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: `Requirement ${seq}`,
          body: "The original body",
          version: 1,
          labels: JSON.stringify(["auth"]),
        },
      });
      return row.id;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("871-concurrent-edit");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-871", username: "u-871", displayName: "u-871", email: "u-871@example.test" },
      });
      await db.workspace.create({ data: { id: "ws-871", name: "ws", slug: "ws-871" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-871", userId: "u-871", role: "owner" },
      });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: "u-871",
          workspaceId: "ws-871",
        },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: "u-871", status: "completed" },
      });
      ADMIN = issueTokens({
        userId: "u-871",
        username: "u-871",
        role: "admin",
        permissions: [],
        workspaces: ["ws-871"],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      state.db = db;
    });

    const routes = [
      {
        name: "PUT /api/requirements/:id",
        send: (id: string, body: Record<string, unknown>) =>
          request(app())
            .put(`/api/requirements/${id}`)
            .set("Authorization", `Bearer ${ADMIN}`)
            .send(body),
      },
      {
        name: "PATCH /api/analyses/:id/requirements/:reqId",
        send: (id: string, body: Record<string, unknown>) =>
          request(app())
            .patch(`/api/analyses/${ANALYSIS}/requirements/${id}`)
            .set("Authorization", `Bearer ${ADMIN}`)
            .send(body),
      },
    ];

    for (const route of routes) {
      describe(route.name, () => {
        it("lets exactly one of two same-version edits win; the other gets a 409", async () => {
          const id = await makeRequirement();
          state.db = withTransactionBarrier(db, 2);

          const [a, b] = await Promise.all([
            route.send(id, { title: "Edit A", version: 1 }),
            route.send(id, { title: "Edit B", version: 1 }),
          ]);

          const statuses = [a.status, b.status].sort();
          expect(statuses).toEqual([200, 409]);
          const winner = a.status === 200 ? a : b;
          const loser = a.status === 200 ? b : a;
          const winnerTitle = winner === a ? "Edit A" : "Edit B";
          const loserTitle = winner === a ? "Edit B" : "Edit A";

          expect(winner.body.data).toMatchObject({ id, version: 2 });
          expect(loser.body.error).toMatchObject({
            code: "VERSION_CONFLICT",
            conflict: true,
            serverVersion: 2,
            clientVersion: 1,
            diff: [{ field: "title", server: winnerTitle, client: loserTitle }],
          });

          state.db = db;
          const row = await db.requirement.findUniqueOrThrow({ where: { id } });
          expect(row).toMatchObject({ title: winnerTitle, version: 2 });
          const history = await db.requirementVersion.findMany({ where: { requirementId: id } });
          expect(history).toHaveLength(1);
          expect(history[0]).toMatchObject({ version: 2 });
          expect(JSON.parse(history[0]!.changedFields)).toEqual({
            title: { from: `Requirement ${seq}`, to: winnerTitle },
          });
        });

        it("lets two concurrent UNVERSIONED edits both apply, in order (last writer wins)", async () => {
          const id = await makeRequirement();
          state.db = withTransactionBarrier(db, 2);

          const [a, b] = await Promise.all([
            route.send(id, { title: "Edit A" }),
            route.send(id, { body: "Edit B body" }),
          ]);

          expect([a.status, b.status]).toEqual([200, 200]);
          state.db = db;
          const row = await db.requirement.findUniqueOrThrow({ where: { id } });
          expect(row).toMatchObject({ title: "Edit A", body: "Edit B body", version: 3 });
          const versions = (
            await db.requirementVersion.findMany({
              where: { requirementId: id },
              orderBy: { version: "asc" },
            })
          ).map((v) => v.version);
          expect(versions).toEqual([2, 3]);
        });

        // #877 — a patch that changes nothing must succeed. An empty conditional
        // UPDATE matches no row on a real database (Prisma issues none), which the
        // write path misread as a lost race: 409 when versioned, 500 after three
        // retries when not.
        const noOps: Array<[string, Record<string, unknown>]> = [
          ["only the current version", { version: 1 }],
          ["an empty body", {}],
          ["unchanged labels, no version", { labels: ["auth"] }],
          ["an unchanged title and the current version", { title: "SAME", version: 1 }],
        ];
        for (const [label, body] of noOps) {
          it(`a no-op patch with ${label} succeeds without a new version`, async () => {
            const id = await makeRequirement();
            const before = await db.requirement.findUniqueOrThrow({ where: { id } });
            const sent = body.title === "SAME" ? { ...body, title: before.title } : body;

            const res = await route.send(id, sent);

            expect(res.status).toBe(200);
            const row = await db.requirement.findUniqueOrThrow({ where: { id } });
            expect(row).toMatchObject({ title: before.title, body: before.body, version: 1 });
            expect(await db.requirementVersion.count({ where: { requirementId: id } })).toBe(0);
          });
        }

        it("a no-op patch carrying a stale version is still a 409", async () => {
          const id = await makeRequirement();
          await route.send(id, { title: "Moved on", version: 1 });

          const res = await route.send(id, { version: 1 });

          expect(res.status).toBe(409);
          expect(res.body.error).toMatchObject({ code: "VERSION_CONFLICT", serverVersion: 2 });
        });
      });
    }
  },
);
