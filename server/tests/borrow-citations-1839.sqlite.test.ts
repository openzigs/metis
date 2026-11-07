/**
 * #1839 (epic #1828) — a requirement starts from a similar requirement's saved
 * code links, as `similar-requirement` suggestions, with no agent run.
 *
 * Real SQLite built from the migration chain. The origin requirement's links
 * are written by the REAL analysis seeder; the borrow goes through the REAL
 * route (auth, project access, permission); and every result is read back
 * through the traceability route on a FRESH Prisma client, and through the
 * #1759 agent seeder's own lookup. Also: the #1839 migration applies
 * up -> reverse -> up.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.REQUIREMENT_SIMILARITY_RATE_LIMIT_MAX = "100000";
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

const { requirementSimilarityRouter } = await import("../src/routes/requirement-similarity.js");
const { traceabilityRouter } = await import("../src/routes/traceability.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { seedRequirementCodeLinksFromFindings } =
  await import("../src/lib/traceability/seed-code-links-from-findings.js");
const { BORROWED_CONFIDENCE_CAP } = await import("../src/lib/traceability/borrow-citations.js");
const { leadWithAgentCitations, prismaAgentCitationDeps } =
  await import("../src/lib/impact-analysis/agent-seeder.js");

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WS_A = "ws-1839-a";
const WS_B = "ws-1839-b";
const A = "p-1839-a";
const B = "p-1839-b";
const COORDINATOR = "u-1839-coord";
const DEVELOPER = "u-1839-dev";
const OUTSIDER = "u-1839-out";
const FILES = ["src/a.ts", "src/b.ts", "src/stale.ts", "src/never.ts"] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1839 — borrow a similar requirement's code links",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const tokens: Record<string, string> = {};
    const ids = { origin: "", target: "", inB: "", targetFinding: "" };

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/requirements", requirementSimilarityRouter());
      a.use("/api/projects/:projectId", traceabilityRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const borrow = (body: unknown, token = tokens.coordinator, to = ids.target, project = A) =>
      request(app())
        .post(`/api/projects/${project}/requirements/${to}/borrow-citations`)
        .set("Authorization", `Bearer ${token}`)
        .send(body as object);
    /** The requirement's direct code links, read through the route on a fresh client. */
    async function directCode(requirementId: string): Promise<Array<Record<string, unknown>>> {
      const fresh = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      const previous = state.db;
      state.db = fresh;
      try {
        const res = await request(app())
          .get(`/api/projects/${A}/requirements/${requirementId}/traceability`)
          .set("Authorization", `Bearer ${tokens.coordinator}`);
        expect(res.status).toBe(200);
        return res.body.data.directCode;
      } finally {
        state.db = previous;
        await fresh.$disconnect();
      }
    }
    const borrowedRows = () =>
      db.requirementCodeMapping.count({ where: { source: "similar-requirement" } });
    /** What the #1759 agent seeder leads the files to edit with, for the target. */
    const agentLead = () =>
      leadWithAgentCitations(
        { editCandidates: [], related: [], schemaSeeds: [] },
        ids.target,
        A,
        prismaAgentCitationDeps(db),
      );

    async function requirementCiting(project: string, title: string, files: readonly string[]) {
      const pass = await db.agentResult.create({
        data: { analysisId: `an-${project}`, agentKey: "code" },
      });
      const finding = await db.finding.create({
        data: {
          agentResultId: pass.id,
          category: "rationale",
          title,
          body: title,
          confidence: 0.9,
          evidence: JSON.stringify({
            citations: files.map((filePath) => ({ filePath, startLine: 2, endLine: 3 })),
          }),
        },
      });
      const requirement = await db.requirement.create({
        data: {
          projectId: project,
          analysisId: `an-${project}`,
          title,
          body: title,
          labels: JSON.stringify([`finding:${finding.id}`]),
        },
      });
      return requirement.id;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1839-borrow-citations");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      const roles: Array<[string, string, string]> = [
        [COORDINATOR, "coordinator", WS_A],
        [DEVELOPER, "developer", WS_A],
        [OUTSIDER, "coordinator", WS_B],
      ];
      for (const ws of [WS_A, WS_B]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [user, roleKey, ws] of roles) {
        const role = await db.role.upsert({
          where: { key: roleKey },
          update: {},
          create: { key: roleKey, name: roleKey, isSystem: true },
        });
        await db.user.create({
          data: { id: user, username: user, displayName: user, email: `${user}@example.test` },
        });
        await db.userRole.create({ data: { userId: user, roleId: role.id, source: "local" } });
        await db.workspaceMember.create({
          data: { workspaceId: ws, userId: user, role: "member" },
        });
        tokens[
          user === COORDINATOR ? "coordinator" : user === DEVELOPER ? "developer" : "outsider"
        ] = issueTokens({
          userId: user,
          username: user,
          role: roleKey as "coordinator" | "developer",
          permissions: [],
          workspaces: [ws],
        }).accessToken;
      }
      for (const [project, ws] of [
        [A, WS_A],
        [B, WS_B],
      ] as const) {
        await db.project.create({
          data: {
            id: project,
            name: project,
            slug: project,
            createdById: COORDINATOR,
            workspaceId: ws,
          },
        });
        await db.analysis.create({
          data: { id: `an-${project}`, projectId: project, startedById: COORDINATOR },
        });
        const graph = await db.codeGraph.create({
          data: { projectId: project, commitSha: "c0ffee".padEnd(40, "0") },
        });
        for (const filePath of FILES) {
          await db.codeSymbol.create({
            data: {
              codeGraphId: graph.id,
              projectId: project,
              kind: "function",
              name: "fn",
              qualifiedName: `${filePath}::fn`,
              filePath,
              startLine: 1,
              endLine: 10,
              language: "ts",
              contentHash: `hash-${filePath}`,
            },
          });
        }
      }

      // The origin's links, written by the real analysis seeder (all fresh) …
      ids.origin = await requirementCiting(A, "Export the ledger as CSV", FILES);
      ids.inB = await requirementCiting(B, "Export the ledger in B", FILES);
      // … and the target's own evidence, not seeded until its analysis runs.
      ids.target = await requirementCiting(A, "Export the ledger as XLSX", ["src/a.ts"]);
      const seeded = await seedRequirementCodeLinksFromFindings({
        analysisId: `an-${A}`,
        projectId: A,
        requirementIds: [ids.origin],
      });
      expect(seeded.linksCreated).toBe(FILES.length);
      await seedRequirementCodeLinksFromFindings({
        analysisId: `an-${B}`,
        projectId: B,
        requirementIds: [ids.inB],
      });
      // Re-validation's verdicts (#1831) on two of the origin's links.
      await db.requirementCodeMapping.updateMany({
        where: { requirementId: ids.origin, filePath: "src/stale.ts" },
        data: { freshness: "stale", staleReason: "content-changed" },
      });
      await db.requirementCodeMapping.updateMany({
        where: { requirementId: ids.origin, filePath: "src/never.ts" },
        data: { freshness: "unverified", codeGraphId: null, validatedAt: null },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("refuses a caller without edit rights (403) and one outside the project (404)", async () => {
      expect((await borrow({ fromRequirementId: ids.origin }, tokens.developer)).status).toBe(403);
      expect((await borrow({ fromRequirementId: ids.origin }, tokens.outsider)).status).toBe(404);
      expect(await borrowedRows()).toBe(0);
    });

    it("answers 404 for another project's fromRequirementId, copying nothing", async () => {
      const res = await borrow({ fromRequirementId: ids.inB });
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe("REQUIREMENT_NOT_FOUND");
      expect(await borrowedRows()).toBe(0);
    });

    it("answers 400 BORROW_FROM_SELF for a requirement borrowing from itself (#1893)", async () => {
      const res = await borrow({ fromRequirementId: ids.origin }, tokens.coordinator, ids.origin);
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("BORROW_FROM_SELF");
      expect(await borrowedRows()).toBe(0);
    });

    it("rejects a malformed body (400)", async () => {
      expect((await borrow({})).status).toBe(400);
      expect((await borrow({ fromRequirementId: ids.origin, extra: 1 })).status).toBe(400);
      expect((await borrow({ fromRequirementId: "x'; DROP TABLE x;--" })).status).toBe(400);
    });

    it("copies the fresh links, skips the stale and unverified ones, and reads them back labelled", async () => {
      const res = await borrow({ fromRequirementId: ids.origin });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        copied: 2,
        skippedStale: 2,
        skippedDuplicate: 0,
        skippedBorrowed: 0,
        notFound: 0,
      });

      const links = await directCode(ids.target);
      expect(
        links.map((l) => [l.filePath, l.source, l.originRequirementId, l.freshness]).sort(),
      ).toEqual([
        ["src/a.ts", "similar-requirement", ids.origin, "fresh"],
        ["src/b.ts", "similar-requirement", ids.origin, "fresh"],
      ]);
      for (const l of links) expect(l.confidence).toBeLessThanOrEqual(BORROWED_CONFIDENCE_CAP);
    });

    it("the agent seeder never leads with a borrowed link", async () => {
      const lead = await agentLead();
      expect(lead.editCandidates).toEqual([]);
      expect(lead.evidence?.agentCitations?.used).toBe(0);
    });

    it("borrowing twice copies nothing the second time", async () => {
      const before = await borrowedRows();
      const res = await borrow({ fromRequirementId: ids.origin });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        copied: 0,
        skippedStale: 2,
        skippedDuplicate: 2,
        skippedBorrowed: 0,
        notFound: 0,
      });
      expect(await borrowedRows()).toBe(before);
    });

    it("counts the origin's borrowed links and unknown mapping ids (#1893)", async () => {
      // The target's links are all borrowed: a third requirement borrowing from it copies none.
      const third = await requirementCiting(A, "Export the ledger as PDF", []);
      const res = await borrow(
        { fromRequirementId: ids.target, mappingIds: ["m-unknown"] },
        undefined,
        third,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        copied: 0,
        skippedStale: 0,
        skippedDuplicate: 0,
        skippedBorrowed: 0,
        notFound: 1,
      });
      const all = await borrow({ fromRequirementId: ids.target }, undefined, third);
      expect(all.body.data).toEqual({
        copied: 0,
        skippedStale: 0,
        skippedDuplicate: 0,
        skippedBorrowed: 2,
        notFound: 0,
      });
    });

    it("once the requirement's own analysis grounds a file, that link wins and is shown once", async () => {
      await seedRequirementCodeLinksFromFindings({
        analysisId: `an-${A}`,
        projectId: A,
        requirementIds: [ids.target],
      });
      const links = await directCode(ids.target);
      expect(links.map((l) => [l.filePath, l.source]).sort()).toEqual([
        ["src/a.ts", "analysis-grounding"],
        ["src/b.ts", "similar-requirement"],
      ]);
      // … and the agent leads with its own citation only, never the borrowed file.
      const lead = await agentLead();
      expect([...new Set(lead.editCandidates.map((m) => m.filePath))]).toEqual(["src/a.ts"]);
    });
  },
);

const MIGRATION = "20261115001839_issue1839_borrowed_citation_origin";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1839 — borrowed-citation origin migration: up -> reverse -> up",
  () => {
    let sqlite: MigratedSqlite;
    const rollback = readFileSync(
      path.join(SERVER_ROOT, "prisma", "rollbacks", `${MIGRATION}.sql`),
      "utf-8",
    );
    const pgUp = readFileSync(
      path.join(SERVER_ROOT, "prisma", "postgres", "migrations", MIGRATION, "migration.sql"),
      "utf-8",
    );
    const pgDown = readFileSync(
      path.join(SERVER_ROOT, "prisma", "postgres", "rollbacks", `${MIGRATION}.sql`),
      "utf-8",
    );
    const withDb = <T>(fn: (db: Database.Database) => T): T => {
      const db = new Database(sqlite.dbFile);
      try {
        return fn(db);
      } finally {
        db.close();
      }
    };
    const columns = () =>
      withDb((db) =>
        (
          db.prepare(`PRAGMA table_info("requirement_code_mappings")`).all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );
    const row = () =>
      withDb((db) =>
        db
          .prepare(
            `SELECT "id","filePath","freshness","source","symbolQualifiedName" FROM "requirement_code_mappings"`,
          )
          .all(),
      );
    let seeded: unknown;
    let before: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("1839-borrow-origin-migration", { stopBefore: MIGRATION });
      withDb((db) => {
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "requirement_code_mappings" ("id","requirementId","projectId","filePath","source","freshness","symbolQualifiedName","createdAt")
           VALUES ('m-1','r-1','p-1','src/a.ts','analysis-grounding','fresh','src/a.ts::fn','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seeded = row();
      before = columns();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the nullable column; reverse restores the shape; up again re-applies",
      () => {
        expect(before).not.toContain("originRequirementId");
        sqlite.apply(MIGRATION);
        expect(columns()).toEqual([...before, "originRequirementId"]);
        expect(row()).toEqual(seeded);
        withDb((db) => db.exec(rollback));
        expect(columns()).toEqual(before);
        expect(row()).toEqual(seeded);
        sqlite.applyRemaining();
        expect(columns()).toContain("originRequirementId");
        expect(row()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin adds and drops the same column, idempotently", () => {
      expect(pgUp).toMatch(/ADD COLUMN IF NOT EXISTS "originRequirementId" TEXT/);
      expect(pgDown).toMatch(/DROP COLUMN IF EXISTS "originRequirementId";/);
      expect(pgDown).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
