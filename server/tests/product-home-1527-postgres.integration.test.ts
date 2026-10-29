/**
 * #1527 — the product home-workspace backfill, on a REAL Postgres.
 *
 * `postgres-migrate-deploy` replays the chain from an EMPTY database, where the
 * backfill never meets a row, and the SQLite twin
 * (`product-home-1527.sqlite.test.ts`) does not run this file. This runs the
 * Postgres `migration.sql` verbatim over seeded rows in a scratch schema, as
 * `notification-project-1447-postgres` does, with each table the backfill reads
 * created with just the columns it reads.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prisma",
  "postgres",
  "migrations",
  "20261104001527_issue1527_product_home_workspace",
  "migration.sql",
);

describe.runIf(enabled)("#1527 product home-workspace backfill on real Postgres", () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  // A fixed prefix plus random hex: safe to interpolate as an identifier.
  const schema = `t1527_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    client.query<T>(sql, params);

  const homes = async () => {
    const { rows } = await q<{ id: string; workspaceId: string | null }>(
      `SELECT "id", "workspaceId" FROM "products"`,
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.workspaceId]));
  };

  const EXPECTED = {
    // The creator's workspace, even though a foreign repo was attached first.
    member: "ws1",
    // A member of both: the earlier-attached one.
    "two-workspaces": "ws2",
    // An admin (local role row, or an IdP row with no override): earliest repo.
    admin: "ws2",
    "provider-admin": "ws2",
    // An IdP admin row overridden by an explicit authority is not an admin.
    "overridden-admin": null,
    "foreign-only": null,
    "legacy-only": null,
    empty: null,
  };

  beforeAll(async () => {
    await client.connect();
    await q(`CREATE SCHEMA "${schema}"`);
    await q(`SET search_path TO "${schema}"`);
    await q(`CREATE TABLE "products" ("id" TEXT PRIMARY KEY, "createdById" TEXT NOT NULL)`);
    await q(
      `CREATE TABLE "product_repos" ("id" TEXT PRIMARY KEY, "productId" TEXT NOT NULL,
         "repoConnectionId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL)`,
    );
    await q(`CREATE TABLE "repo_connections" ("id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL)`);
    await q(`CREATE TABLE "projects" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT)`);
    await q(
      `CREATE TABLE "workspace_members" ("workspaceId" TEXT NOT NULL, "userId" TEXT NOT NULL)`,
    );
    await q(`CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "authRoleAuthority" TEXT NOT NULL)`);
    await q(`CREATE TABLE "roles" ("id" TEXT PRIMARY KEY, "key" TEXT NOT NULL)`);
    await q(
      `CREATE TABLE "user_roles" ("userId" TEXT NOT NULL, "roleId" TEXT NOT NULL, "source" TEXT NOT NULL)`,
    );

    await q(`INSERT INTO "roles" VALUES ('r-admin','admin'), ('r-coord','coordinator')`);
    await q(
      `INSERT INTO "users" VALUES ('alice','unknown'), ('carol','unknown'), ('ada','unknown'),
         ('pam','unknown'), ('olive','explicit')`,
    );
    await q(
      `INSERT INTO "user_roles" VALUES ('alice','r-coord','local'), ('carol','r-coord','local'),
         ('ada','r-admin','local'), ('pam','r-admin','provider'), ('olive','r-admin','provider')`,
    );
    await q(
      `INSERT INTO "workspace_members" VALUES ('ws1','alice'), ('ws1','carol'), ('ws2','carol')`,
    );
    await q(`INSERT INTO "projects" VALUES ('pa','ws1'), ('pb','ws2'), ('pl',NULL)`);
    await q(`INSERT INTO "repo_connections" VALUES ('a','pa'), ('b','pb'), ('l','pl')`);

    let minute = 0;
    const product = async (id: string, createdById: string, repos: string[]) => {
      await q(`INSERT INTO "products" VALUES ($1, $2)`, [id, createdById]);
      for (const repo of repos) {
        await q(`INSERT INTO "product_repos" VALUES ($1, $2, $3, $4)`, [
          `pr-${id}-${repo}`,
          id,
          repo,
          new Date(Date.UTC(2026, 0, 1, 0, minute++)),
        ]);
      }
    };
    await product("member", "alice", ["b", "a"]);
    await product("two-workspaces", "carol", ["b", "a"]);
    await product("admin", "ada", ["b", "a"]);
    await product("provider-admin", "pam", ["b"]);
    await product("overridden-admin", "olive", ["b"]);
    await product("foreign-only", "alice", ["b"]);
    await product("legacy-only", "alice", ["l"]);
    await product("empty", "alice", []);

    await q(readFileSync(MIGRATION, "utf8"));
  });

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  it("homes each product in the earliest-attached repo its creator could attach, else NULL", async () => {
    expect(await homes()).toEqual(EXPECTED);
  });

  it("is re-runnable: a second pass changes nothing", async () => {
    await q(readFileSync(MIGRATION, "utf8"));
    expect(await homes()).toEqual(EXPECTED);
  });
});
