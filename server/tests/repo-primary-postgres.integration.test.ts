/**
 * Issue #457 — one live primary repository per project, on a REAL Postgres.
 *
 * `postgres-migrate-deploy` replays the Postgres chain from an EMPTY database,
 * so the demote `UPDATE` in #457's Postgres migration never meets an extra
 * primary there, and the SQLite twin (`repo-primary-unique-457.sqlite.test.ts`)
 * is skipped on Postgres. This suite:
 *
 *   1. runs the Postgres `migration.sql` verbatim, from disk, over seeded extra
 *      primaries in a scratch schema cloned from the pushed `repo_connections`
 *      (`LIKE ... INCLUDING DEFAULTS`: no indexes, so the rows can exist), and
 *   2. races two first creates through the real `createRepoConnector` on the
 *      real tables — every create counts before any inserts — and asserts one
 *      primary. On Postgres the loser's insert waits on the winner's index entry
 *      and then fails with 23505 (P2002), which the service retries non-primary.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { countBarrier, overrideRepoConnection } from "./helpers/repo-count-barrier.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const state = vi.hoisted(() => ({ db: null as unknown }));
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
const { createRepoConnector, createUploadRepoConnector } =
  await import("../src/lib/connectors/repo/repo-service.js");

const MIGRATION = "20261003000457_issue457_repo_primary_unique";
const migrationSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "prisma",
    "postgres",
    "migrations",
    MIGRATION,
    "migration.sql",
  ),
  "utf8",
);

describe.runIf(enabled)(
  "repo_connections one live primary per project (real Postgres, #457)",
  () => {
    describe("migration over extra primaries (scratch schema)", () => {
      const client = new pg.Client({ connectionString: databaseUrl });
      // A fixed prefix plus random hex: safe to interpolate as an identifier.
      const schema = `t457_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
        client.query<T>(sql, params);

      beforeAll(async () => {
        await client.connect();
        await q(`CREATE SCHEMA "${schema}"`);
        await q(
          `CREATE TABLE "${schema}"."repo_connections" (LIKE public."repo_connections" INCLUDING DEFAULTS)`,
        );
        await q(`SET search_path TO "${schema}"`);
        const rows: Array<[string, string, boolean, string, string | null]> = [
          ["r_new", "p1", true, "2026-09-02", null],
          ["r_old_b", "p1", true, "2026-09-01", null],
          ["r_old_a", "p1", true, "2026-09-01", null],
          ["r_plain", "p1", false, "2026-09-01", null],
          ["r_gone", "p1", true, "2026-09-01", "2026-09-01"],
          ["r_solo", "p2", true, "2026-09-02", null],
        ];
        for (const [id, projectId, isPrimary, createdAt, deletedAt] of rows) {
          await q(
            `INSERT INTO "repo_connections"
           ("id", "projectId", "label", "isPrimary", "createdAt", "updatedAt", "deletedAt")
           VALUES ($1, $2, $1, $3, $4, $4, $5)`,
            [id, projectId, isPrimary, createdAt, deletedAt],
          );
        }
        await q(migrationSql);
      });

      afterAll(async () => {
        await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await client.end();
      });

      const primaryIds = async () =>
        (
          await q<{ id: string }>(
            `SELECT "id" FROM "repo_connections" WHERE "isPrimary" ORDER BY "id"`,
          )
        ).rows.map((r) => r.id);

      it("demotes extra live primaries, keeping the oldest (then lowest id)", async () => {
        // r_gone is soft-deleted, so outside the index and left untouched.
        expect(await primaryIds()).toEqual(["r_gone", "r_old_a", "r_solo"]);
      });

      it("then builds the partial unique index, which rejects a second live primary", async () => {
        const idx = await q<{ indexdef: string }>(
          `SELECT "indexdef" FROM pg_indexes
         WHERE schemaname = $1 AND indexname = 'repo_connections_projectId_primary_key'`,
          [schema],
        );
        expect(idx.rows).toHaveLength(1);
        await expect(
          q(
            `INSERT INTO "repo_connections" ("id", "projectId", "label", "isPrimary", "updatedAt")
           VALUES ('dup', 'p1', 'dup', true, CURRENT_TIMESTAMP)`,
          ),
        ).rejects.toMatchObject({ code: "23505" });
      });

      it("is a no-op when run again", async () => {
        const before = await primaryIds();
        await q(migrationSql);
        expect(await primaryIds()).toEqual(before);
      });
    });

    describe("concurrent first creates through the service (real tables)", () => {
      const db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
      const suffix = randomUUID().slice(0, 8);
      const userId = `u457_${suffix}`;
      const projectId = `p457_${suffix}`;

      beforeAll(async () => {
        await db.user.create({
          data: {
            id: userId,
            username: userId,
            displayName: "U",
            email: `${userId}@example.test`,
          },
        });
        await db.project.create({
          data: { id: projectId, name: "Apollo", slug: projectId, createdById: userId },
        });
      });

      afterAll(async () => {
        await db.repoConnection.deleteMany({ where: { projectId } });
        await db.project.deleteMany({ where: { id: projectId } });
        await db.user.deleteMany({ where: { id: userId } });
        await db.$disconnect();
      });

      it("leaves exactly one primary", async () => {
        state.db = countBarrier(db, 2);
        const created = await Promise.all(
          ["a", "b"].map((label) =>
            createRepoConnector(projectId, { label, ownerOrOrg: "o", repoName: label }, userId),
          ),
        );
        expect(created.map((c) => c.isPrimary).sort()).toEqual([false, true]);
        const rows = await db.repoConnection.findMany({ where: { projectId } });
        expect(rows).toHaveLength(2);
        expect(rows.filter((r) => r.isPrimary)).toHaveLength(1);
      });
    });

    describe("#463 — upload validates before insert; only the primary index retries", () => {
      const db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
      const suffix = randomUUID().slice(0, 8);
      const userId = `u463_${suffix}`;
      const projects = { race: `p463a_${suffix}`, clash: `p463b_${suffix}` };
      let tmp: string;

      beforeAll(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "metis-463-pg-"));
        process.env.UPLOAD_EXTRACT_DIR = path.join(tmp, "extracts");
        process.env.UPLOAD_ARCHIVE_DIR = path.join(tmp, "archives");
        await db.user.create({
          data: { id: userId, username: userId, displayName: "U", email: `${userId}@example.test` },
        });
        for (const id of Object.values(projects)) {
          await db.project.create({ data: { id, name: "Apollo", slug: id, createdById: userId } });
        }
      });

      afterAll(async () => {
        const ids = Object.values(projects);
        await db.repoConnection.deleteMany({ where: { projectId: { in: ids } } });
        await db.project.deleteMany({ where: { id: { in: ids } } });
        await db.user.deleteMany({ where: { id: userId } });
        await db.$disconnect();
        await fs.rm(tmp, { recursive: true, force: true });
        delete process.env.UPLOAD_EXTRACT_DIR;
        delete process.env.UPLOAD_ARCHIVE_DIR;
      });

      it("a failed upload never takes the primary flag from a create racing it", async () => {
        const real = db.repoConnection;
        const labels: string[] = [];
        let raced = false;
        const race = () =>
          createRepoConnector(
            projects.race,
            { label: "good", ownerOrOrg: "o", repoName: "good" },
            userId,
          );
        state.db = overrideRepoConnection(db, {
          create: async (args: Parameters<typeof real.create>[0]) => {
            labels.push(String(args.data.label));
            const row = await real.create(args);
            if (args.data.label === "bad" && !raced) {
              raced = true;
              await race();
            }
            return row;
          },
        });
        try {
          await expect(
            createUploadRepoConnector(projects.race, "bad", Buffer.from("not a zip"), userId),
          ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
          if (!raced) await race();
        } finally {
          state.db = db;
        }
        expect(labels).not.toContain("bad");
        const rows = await db.repoConnection.findMany({ where: { projectId: projects.race } });
        expect(rows.map((r) => [r.label, r.isPrimary])).toEqual([["good", true]]);
      });

      it("a label held by a soft-deleted row fails once, without a non-primary retry", async () => {
        await db.repoConnection.create({
          data: { projectId: projects.clash, label: "old", deletedAt: new Date() },
        });
        const real = db.repoConnection;
        let creates = 0;
        state.db = overrideRepoConnection(db, {
          create: async (args: Parameters<typeof real.create>[0]) => {
            creates += 1;
            return real.create(args);
          },
        });
        try {
          await expect(
            createRepoConnector(
              projects.clash,
              { label: "old", ownerOrOrg: "o", repoName: "old" },
              userId,
            ),
          ).rejects.toMatchObject({ code: "P2002" });
        } finally {
          state.db = db;
        }
        expect(creates).toBe(1);
      });
    });
  },
);
