/**
 * Issue #492 — repo connector labels through the REAL connectors router on a
 * REAL Postgres (the SQLite twin is repo-connector-followups-492.sqlite.test.ts,
 * which is skipped when the generated client is Postgres).
 *
 *   1. Deleting a connector, then creating one under the same label, succeeds:
 *      `repo_connections_projectId_label_key` is partial (`WHERE "deletedAt" IS NULL`).
 *   2. A second LIVE row under one label is still rejected by that index.
 *   3. Renaming a connector onto a live connector's label is a 409.
 *   4. A rename that loses the race (pre-check passes, the write then collides)
 *      is still a 409: Postgres's P2002 names the index, which the service maps.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");
const { connectorsRouter } = await import("../src/routes/connectors.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

describe.runIf(enabled)("repo connector labels on a real Postgres (#492)", () => {
  const db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
  const suffix = randomUUID().slice(0, 8);
  const userId = `u492_${suffix}`;
  const projectId = `p492_${suffix}`;
  let ADMIN = "";

  const app = () => {
    const a = express();
    a.use(express.json());
    a.use("/api/projects/:projectId/connectors", connectorsRouter());
    a.use(notFoundHandler);
    a.use(errorHandler);
    return a;
  };
  const base = `/api/projects/${projectId}/connectors`;
  const post = (label: string) =>
    request(app())
      .post(`${base}/repos`)
      .set("Authorization", `Bearer ${ADMIN}`)
      .send({ label, ownerOrOrg: "octocat", repoName: "demo" });

  beforeAll(async () => {
    state.db = db;
    await db.user.create({
      data: { id: userId, username: userId, displayName: "U", email: `${userId}@example.test` },
    });
    await db.project.create({
      data: { id: projectId, name: "Apollo", slug: projectId, createdById: userId },
    });
    // A live repository already exists, so no create below is the project's
    // first and none of them starts a background auto-ingest.
    await db.repoConnection.create({
      data: { projectId, label: "live", isPrimary: true, createdById: userId },
    });
    ADMIN = issueTokens({
      userId,
      username: userId,
      role: "admin",
      permissions: [],
      workspaces: [],
    }).accessToken;
  });

  afterAll(async () => {
    await db.repoConnection.deleteMany({ where: { projectId } });
    await db.project.deleteMany({ where: { id: projectId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it("deleting a connector, then creating one with the same label, succeeds", async () => {
    const first = await post("reused");
    expect(first.status).toBe(201);
    const del = await request(app())
      .delete(`${base}/repos/${String(first.body.data.id)}`)
      .set("Authorization", `Bearer ${ADMIN}`);
    expect(del.status).toBe(204);

    const again = await post("reused");
    expect(again.status).toBe(201);
    const rows = await db.repoConnection.findMany({
      where: { projectId, label: "reused" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.deletedAt === null)).toEqual([false, true]);
  });

  it("a second live connector under one label is still rejected by the index", async () => {
    await expect(
      db.repoConnection.create({ data: { projectId, label: "live", createdById: userId } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("renaming a connector to a live connector's label is a 409", async () => {
    const created = await post("to-rename");
    const id = String(created.body.data.id);
    const res = await request(app())
      .patch(`${base}/repos/${id}`)
      .set("Authorization", `Bearer ${ADMIN}`)
      .send({ label: "live" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "REPO_LABEL_TAKEN" });
    expect((await db.repoConnection.findUniqueOrThrow({ where: { id } })).label).toBe("to-rename");
  });

  it("a rename that loses the race for a label is a 409, not a 500", async () => {
    const created = await post("racer");
    const id = String(created.body.data.id);
    // The pre-check reads before the rival row exists; the write then collides.
    const real = db.repoConnection;
    let raced = false;
    state.db = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "repoConnection") return Reflect.get(target, prop, receiver);
        return new Proxy(real, {
          get(t, p, r) {
            if (p !== "findFirst") return Reflect.get(t, p, r);
            return async (args: Parameters<typeof real.findFirst>[0]) => {
              const where = (args?.where ?? {}) as { label?: unknown };
              if (where.label === "prize" && !raced) {
                raced = true;
                const found = await real.findFirst(args);
                await real.create({ data: { projectId, label: "prize", createdById: userId } });
                return found;
              }
              return real.findFirst(args);
            };
          },
        });
      },
    });
    let res;
    try {
      res = await request(app())
        .patch(`${base}/repos/${id}`)
        .set("Authorization", `Bearer ${ADMIN}`)
        .send({ label: "prize" });
    } finally {
      state.db = db;
    }
    expect(raced).toBe(true);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "REPO_LABEL_TAKEN" });
    expect((await db.repoConnection.findUniqueOrThrow({ where: { id } })).label).toBe("racer");
  });
});
