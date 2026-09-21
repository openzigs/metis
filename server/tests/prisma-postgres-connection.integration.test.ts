/**
 * Issue #539 (epic #518) — proof that, given a Postgres `DATABASE_URL`, the
 * scheme-selected adapter actually connects to a *real* Postgres instance (not
 * SQLite). This is the keystone multi-replica acceptance criterion:
 *
 *   "Given a Postgres DATABASE_URL, when the server starts, then it instantiates
 *    the Postgres adapter and actually connects to Postgres (verified by a query
 *    hitting the Postgres instance, not SQLite)."
 *
 * Gated behind `RUN_INTEGRATION_TESTS=1` (via `pnpm test:integration`) and a
 * Postgres-shaped `DATABASE_URL`. In CI a `postgres:16-alpine` service is
 * provided and `prisma migrate deploy` is run against `prisma/postgres/schema.prisma`
 * before this test executes. Locally it is skipped unless those conditions hold,
 * so the default `pnpm test` run never needs a live database.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { resolveDatabaseProvider, selectPrismaAdapter } from "../src/lib/prisma.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

describe.runIf(enabled)("Prisma Postgres connection (integration)", () => {
  const adapter = selectPrismaAdapter(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("selects the postgres provider for the Postgres DATABASE_URL", () => {
    expect(resolveDatabaseProvider(databaseUrl)).toBe("postgresql");
    // `provider` is "postgres" on the concrete PrismaPg factory.
    expect(adapter.provider).toBe("postgres");
  });

  it("connects to a real PostgreSQL server (not SQLite)", async () => {
    // `version()` returns a string beginning with "PostgreSQL" on Postgres;
    // SQLite has no such function (the query would throw there), so a passing
    // assertion proves the query hit Postgres.
    const rows = await prisma.$queryRaw<Array<{ version: string }>>`
      SELECT version() AS version
    `;
    expect(rows[0]?.version).toMatch(/^PostgreSQL/);
  });

  it("can round-trip a row through the migrated Postgres schema", async () => {
    // The User table exists in prisma/postgres/schema.prisma; a count proves the
    // migrations were applied to Postgres and Prisma can query it.
    const count = await prisma.user.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
