/**
 * #865 — `PATCH /api/analyses/:id/requirements/:reqId` is a VERSIONED write.
 *
 * It used to update the requirement row in place: no `version` bump, no
 * `RequirementVersion` row. A baseline pins `(requirementId, version)`, so a
 * baseline taken after such an edit pinned the SAME version as one taken
 * before it, and the compare reported the requirement as unchanged.
 *
 * Proven through the real analysis router against a real SQLite database built
 * from the migration chain, with the real `assertProjectAccess` and the real
 * baseline service — nothing on the write or compare path is mocked.
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
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { createManualBaseline, compareBaselines } =
  await import("../src/lib/reviews/baseline-service.js");

const PROJECT = "proj-865";
const ANALYSIS = "ana-865";
const OTHER_ANALYSIS = "ana-865-other";
const FOREIGN_PROJECT = "proj-865-foreign";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#865 — the analysis-scoped requirement PATCH is versioned",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let DEV = "";
    let OUTSIDER = "";
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/analyses", initAnalysisRouter().topLevel);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const patch = (reqId: string, body: Record<string, unknown>, bearer = DEV) =>
      request(app())
        .patch(`/api/analyses/${ANALYSIS}/requirements/${reqId}`)
        .set("Authorization", `Bearer ${bearer}`)
        .send(body);

    const makeRequirement = async (overrides: { analysisId?: string; labels?: string[] } = {}) => {
      seq += 1;
      const row = await db.requirement.create({
        data: {
          id: `req-865-${seq}`,
          projectId: PROJECT,
          analysisId: overrides.analysisId ?? ANALYSIS,
          title: `Requirement ${seq}`,
          body: "The original body",
          version: 1,
          labels: JSON.stringify(overrides.labels ?? ["auth"]),
        },
      });
      return row.id;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("865-analysis-patch-version");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-dev", "u-out"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-865", name: "ws", slug: "ws-865" } });
      await db.workspace.create({ data: { id: "ws-865-x", name: "wsx", slug: "ws-865-x" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-865", userId: "u-dev", role: "member" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-865-x", userId: "u-out", role: "owner" },
      });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: "u-out",
          workspaceId: "ws-865",
        },
      });
      await db.project.create({
        data: {
          id: FOREIGN_PROJECT,
          name: FOREIGN_PROJECT,
          slug: FOREIGN_PROJECT,
          createdById: "u-out",
          workspaceId: "ws-865-x",
        },
      });
      for (const id of [ANALYSIS, OTHER_ANALYSIS]) {
        await db.analysis.create({
          data: { id, projectId: PROJECT, startedById: "u-dev", status: "completed" },
        });
      }
      // A developer who did NOT create the project but is a workspace member.
      DEV = issueTokens({
        userId: "u-dev",
        username: "u-dev",
        role: "developer",
        permissions: [],
        workspaces: ["ws-865"],
      }).accessToken;
      OUTSIDER = issueTokens({
        userId: "u-out",
        username: "u-out",
        role: "developer",
        permissions: [],
        workspaces: ["ws-865-x"],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      await db.requirementVersion.deleteMany({});
    });

    it("bumps the version and appends a history row", async () => {
      const id = await makeRequirement();

      const res = await patch(id, { title: "Edited through PATCH", priority: "high" });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id, version: 2 });
      const row = await db.requirement.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ title: "Edited through PATCH", priority: "high", version: 2 });
      const history = await db.requirementVersion.findMany({ where: { requirementId: id } });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ version: 2, actorId: "u-dev" });
      expect(JSON.parse(history[0]!.changedFields)).toEqual({
        title: { from: `Requirement ${seq}`, to: "Edited through PATCH" },
        priority: { from: "medium", to: "high" },
      });
    });

    it("shows the edit in a baseline compare", async () => {
      const id = await makeRequirement();
      const before = (await createManualBaseline("u-dev", PROJECT, {
        name: "before",
        requirementIds: [id],
      })) as { id: string };

      expect((await patch(id, { body: "The edited body" })).status).toBe(200);

      const after = (await createManualBaseline("u-dev", PROJECT, {
        name: "after",
        requirementIds: [id],
      })) as { id: string };
      const compare = await compareBaselines(before.id, after.id);

      expect(compare.unchanged).toEqual([]);
      expect(compare.changed).toHaveLength(1);
      expect(compare.changed[0]).toMatchObject({
        requirementId: id,
        fromVersion: 1,
        toVersion: 2,
        changedFields: { body: { from: "The original body", to: "The edited body" } },
      });
    });

    it("leaves the version alone for a no-op patch", async () => {
      const id = await makeRequirement();

      const res = await patch(id, { priority: "medium" });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id, version: 1 });
      expect(await db.requirementVersion.count({ where: { requirementId: id } })).toBe(0);
    });

    it("keeps finding traceability labels and strips legacy review labels", async () => {
      const id = await makeRequirement({ labels: ["auth", "finding:f-1", "review:approved"] });

      const res = await patch(id, { labels: ["security"], reviewStatus: "approved" });

      expect(res.status).toBe(200);
      const row = await db.requirement.findUniqueOrThrow({ where: { id } });
      const labels = JSON.parse(row.labels) as string[];
      expect(labels).toContain("security");
      expect(labels).toContain("finding:f-1");
      expect(labels.some((l) => l.startsWith("review:"))).toBe(false);
      expect(row.reviewStatus).toBe("approved");
      expect(row.version).toBe(2);
    });

    it("honours the optimistic-concurrency version: a stale one is a 409 and writes nothing", async () => {
      const id = await makeRequirement();
      expect((await patch(id, { title: "First edit", version: 1 })).status).toBe(200);

      const stale = await patch(id, { title: "Lost update", version: 1 });

      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatchObject({
        code: "VERSION_CONFLICT",
        serverVersion: 2,
        clientVersion: 1,
      });
      expect(stale.body.error.diff).toEqual([
        { field: "title", server: "First edit", client: "Lost update" },
      ]);
      const row = await db.requirementVersion.count({ where: { requirementId: id } });
      expect(row).toBe(1);
      expect((await db.requirement.findUniqueOrThrow({ where: { id } })).title).toBe("First edit");
    });

    it("diffs visible labels only on a 409: hidden finding/review labels never conflict", async () => {
      const id = await makeRequirement({ labels: ["auth", "finding:f-1", "review:approved"] });
      expect((await patch(id, { title: "First edit", version: 1 })).status).toBe(200);

      const sameLabels = await patch(id, { title: "Lost update", labels: ["auth"], version: 1 });

      expect(sameLabels.status).toBe(409);
      expect(sameLabels.body.error.diff).toEqual([
        { field: "title", server: "First edit", client: "Lost update" },
      ]);

      const otherLabels = await patch(id, { labels: ["security"], version: 1 });

      expect(otherLabels.status).toBe(409);
      expect(otherLabels.body.error.diff).toEqual([
        { field: "labels", server: ["auth"], client: ["security"] },
      ]);
    });

    it("accepts the current version", async () => {
      const id = await makeRequirement();

      const res = await patch(id, { title: "Fresh edit", version: 1 });

      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(2);
    });

    it("answers 404 for a requirement of another analysis, before the lock can diff it", async () => {
      const id = await makeRequirement({ analysisId: OTHER_ANALYSIS });

      const res = await patch(id, { title: "Cross-analysis", version: 99 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
      expect((await db.requirement.findUniqueOrThrow({ where: { id } })).version).toBe(1);
    });

    it("answers a non-member the unknown-analysis 404 and never reaches the lock", async () => {
      const id = await makeRequirement();

      const res = await patch(id, { title: "Outsider", version: 99 }, OUTSIDER);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
      expect(JSON.stringify(res.body)).not.toContain("Requirement ");
    });
  },
);
