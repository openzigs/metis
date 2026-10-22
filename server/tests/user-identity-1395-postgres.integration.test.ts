/**
 * #1395 — the user-identity migration and the login race, on a REAL Postgres.
 *
 * `postgres-migrate-deploy` replays the chain from an EMPTY database, so the
 * `authSource` backfill there never meets a row. This runs the Postgres
 * `migration.sql` verbatim over seeded users and login audit rows in a scratch
 * schema (cloned from the pushed tables with `LIKE ... INCLUDING DEFAULTS`,
 * minus the column the migration adds), as `issue-draft-dedup-postgres` does.
 *
 * It then races concurrent first sign-ins of one identity through the real
 * `resolveLoginUser` on the real tables: exactly one user and one identity
 * must exist afterwards, every racer must land on it, and a concurrent sign-in
 * from ANOTHER provider with the same username must be refused.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
const { resolveLoginUser } = await import("../src/lib/auth/login-identity.js");

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prisma",
  "postgres",
  "migrations",
  "20261025001395_issue1395_user_identities",
  "migration.sql",
);

describe.runIf(enabled)("#1395 user identities on real Postgres (integration)", () => {
  describe("the migration's authSource backfill", () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    // A fixed prefix plus random hex: safe to interpolate as an identifier.
    const schema = `t1395_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
      client.query<T>(sql, params);

    beforeAll(async () => {
      await client.connect();
      await q(`CREATE SCHEMA "${schema}"`);
      await q(`CREATE TABLE "${schema}"."users" (LIKE public."users" INCLUDING DEFAULTS)`);
      await q(`ALTER TABLE "${schema}"."users" DROP COLUMN "authSource"`);
      await q(`ALTER TABLE "${schema}"."users" ADD PRIMARY KEY ("id")`);
      await q(
        `CREATE TABLE "${schema}"."audit_logs" (LIKE public."audit_logs" INCLUDING DEFAULTS)`,
      );
      await q(`SET search_path TO "${schema}"`);
      for (const id of ["oidc_only", "saml_only", "mixed", "password", "never"]) {
        await q(
          `INSERT INTO "users" ("id","username","displayName","email","updatedAt")
           VALUES ($1,$1,$1,$1 || '@corp.test', now())`,
          [id],
        );
      }
      const login = (id: string, actor: string, metadata: Record<string, unknown> | null) =>
        q(
          `INSERT INTO "audit_logs" ("id","actorId","action","targetType","targetId","metadata")
           VALUES ($1,$2,'user.login','user',$2,$3)`,
          [id, actor, metadata ? JSON.stringify(metadata) : null],
        );
      await login("l1", "oidc_only", { username: "oidc_only", mode: "oidc" });
      await login("l2", "saml_only", { username: "saml_only", mode: "saml" });
      await login("l3", "mixed", { username: "mixed", mode: "oidc" });
      await login("l4", "mixed", { username: "mixed" });
      await login("l5", "password", { username: "password", mode: "ldap" });
      await q(
        `INSERT INTO "users" ("id","username","displayName","email","authRoleAuthority","updatedAt")
         VALUES ('scim_new','scim_new','s','scim_new@corp.test','scim', now())`,
      );
      await q(readFileSync(MIGRATION, "utf8"));
    });

    afterAll(async () => {
      await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    });

    it("records a single-mode SSO history and leaves the rest legacy (NULL)", async () => {
      const { rows } = await q<{ id: string; authSource: string | null }>(
        `SELECT "id", "authSource" FROM "users" ORDER BY "id"`,
      );
      expect(Object.fromEntries(rows.map((r) => [r.id, r.authSource]))).toEqual({
        mixed: null,
        never: null,
        oidc_only: "oidc",
        password: null,
        saml_only: "saml",
        scim_new: "scim",
      });
      const { rows: tables } = await q<{ n: string }>(
        `SELECT count(*) AS n FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = 'user_identities'`,
        [schema],
      );
      expect(Number(tables[0].n)).toBe(1);
    });

    it("is re-runnable: a second pass changes nothing", async () => {
      await q(readFileSync(MIGRATION, "utf8"));
      const { rows } = await q<{ n: string }>(
        `SELECT count(*) AS n FROM "users" WHERE "authSource" IS NOT NULL`,
      );
      expect(Number(rows[0].n)).toBe(3);
    });
  });

  describe("concurrent sign-ins", () => {
    let db: PrismaClient;
    const suffix = randomUUID().slice(0, 8);
    const username = `race-${suffix}`;
    const issuer = `https://idp-${suffix}.test`;

    beforeAll(() => {
      db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
      state.db = db;
    });

    afterAll(async () => {
      await db.user.deleteMany({ where: { username: { in: [username, `legacy-${suffix}`] } } });
      await db.$disconnect();
    });

    it("racing claims of one unbound legacy row bind exactly one identity", async () => {
      const legacy = `legacy-${suffix}`;
      const row = await db.user.create({
        data: {
          username: legacy,
          displayName: "L",
          email: `${legacy}@corp.test`,
          authSource: "oidc",
        },
      });
      // Eight different subjects of the row's own kind contest it at once.
      const claims = Array.from({ length: 8 }, (_, i) =>
        resolveLoginUser({
          identity: { provider: "oidc", issuer, subject: `claim-${i}-${suffix}` },
          profile: { username: legacy, displayName: "L", email: `${legacy}@corp.test` },
          primaryKind: "ldap",
        }),
      );
      const results = await Promise.allSettled(claims);
      const bound = await db.userIdentity.findMany({ where: { userId: row.id } });
      expect(bound).toHaveLength(1);
      const won = results.filter((r) => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      for (const r of results.filter((r) => r.status === "rejected")) {
        expect(r).toMatchObject({ reason: { statusCode: 409, code: "ACCOUNT_LINK_REQUIRED" } });
      }
    });

    it("racing first sign-ins of one identity make one user; another provider is refused", async () => {
      const profile = { username, displayName: "Race", email: `${username}@corp.test` };
      const same = () =>
        resolveLoginUser({
          identity: { provider: "oidc", issuer, subject: `sub-${suffix}` },
          profile,
          primaryKind: "ldap",
        });
      const intruder = resolveLoginUser({
        identity: { provider: "saml", issuer: "urn:other", subject: "x" },
        profile: { ...profile, email: `intruder-${suffix}@corp.test` },
        primaryKind: "ldap",
      });
      const results = await Promise.allSettled([same(), same(), same(), same(), intruder]);

      // Whichever provider created the row first owns it; the other is refused.
      const users = await db.user.findMany({ where: { username }, include: { identities: true } });
      expect(users).toHaveLength(1);
      expect(users[0].identities).toHaveLength(1);
      const winner = users[0].identities[0].provider;
      const providers = ["oidc", "oidc", "oidc", "oidc", "saml"];
      results.forEach((r, i) => {
        if (providers[i] === winner) {
          expect(r).toMatchObject({ status: "fulfilled", value: { id: users[0].id } });
        } else {
          expect(r).toMatchObject({
            status: "rejected",
            reason: { statusCode: 409, code: "ACCOUNT_LINK_REQUIRED" },
          });
        }
      });
    });
  });
});
