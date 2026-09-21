/**
 * Issue #806 — per-suite Postgres schema isolation for the `postgres-adapter` CI job.
 *
 * ## The coupling this removes
 *
 * Every Postgres integration suite in the `postgres-adapter` job runs against the SAME
 * database. The pgvector store self-creates ONE `rag_vectors` table with a FIXED-width
 * `vector(N)` column, and #783's dimension guard refuses a `PgVectorStore` whose
 * configured width disagrees with the column that already exists. So two suites that pick
 * DIFFERENT widths cannot coexist: whichever runs SECOND fails at `ensureSchema()`, naming
 * a table neither suite appears to own. The #805 stop-gap (`PG_TEST_VECTOR_DIM`) made every
 * suite share ONE width so they could never disagree — it removed the drift, not the
 * shared-state coupling.
 *
 * ## The fix: a private schema per suite
 *
 * Each suite gets its OWN Postgres schema and pins `search_path=<schema>,public` at CONNECT
 * time on every client it builds. Its `rag_vectors` (and `reindex_lease`, etc.) then live in
 * ITS schema, invisible to any other suite, so the vector width stops being a global and each
 * suite can choose freely.
 *
 * ### Gotcha 1 — the `vector` extension is DATABASE-scoped, not schema-scoped
 *
 * `CREATE EXTENSION vector` installs the `vector` TYPE and its operator classes into ONE
 * schema for the whole database; it cannot be created per-test-schema. So we create it ONCE
 * in `public` ({@link ensurePgTestSchema}) and keep `public` on every suite's `search_path`
 * (`<schema>,public`). Type resolution (`vector(N)`, `vector_cosine_ops`, …) then works from
 * every test schema. Because the extension already exists in `public`, the stores' own
 * `CREATE EXTENSION IF NOT EXISTS vector` short-circuits (it matches `pg_extension` by name,
 * database-wide) and never tries to install a second copy into a test schema.
 *
 * ### Gotcha 2 — `search_path` is per-CONNECTION, and pools open many connections
 *
 * A top-level `SET search_path` binds the ONE session that ran it; a Prisma/pg POOL hands
 * later statements to OTHER pooled backends that never saw it. Several suites build extra
 * `PrismaClient`s (their own pools) to model separate pods. So we pin the schema in the
 * libpq startup packet — `options=-c search_path=<schema>,public` — which Postgres applies
 * to EVERY connection the pool opens, at connect time. {@link makeSchemaScopedPrismaClient}
 * and {@link schemaScopedAdapter} are the single seam every client is built through.
 *
 * ### Gotcha 3 — advisory-lock ids are GLOBAL (database-wide), not per-schema
 *
 * The stores serialize their one-time table bootstrap with `pg_advisory_xact_lock(<id>)`
 * (`vector-store-pgvector.ts` = 543000001, `reindex-lease.ts` = 798000001). Per-schema
 * isolation does NOT give per-schema lock namespaces: two suites in different schemas that
 * bootstrap concurrently would still contend on the same global id.
 *
 * We ACCEPT that and do NOT namespace the ids, deliberately:
 *   - The `postgres-adapter` job runs each suite as a SEPARATE, SEQUENTIAL step
 *     (`pnpm test:integration <name>` one after another), so no two suites' bootstraps ever
 *     run at the same time — there is nothing to contend.
 *   - Even under hypothetical concurrency the collision is harmless: these are XACT-scoped
 *     locks that guard only the one-time `CREATE TABLE`, released automatically at COMMIT.
 *     A collision merely serializes two CREATEs and self-heals — it can NEVER wedge (that is
 *     the whole distinction from the #798 SESSION advisory-lock leak this repo already fixed).
 *   - The ids live in SOURCE (not test) code, and production runs a single schema, so
 *     namespacing them by schema would distort production behavior for a test-only concern.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/** A Postgres-shaped `DATABASE_URL` (the only case these helpers are used in). */
export function isPostgresUrl(url: string): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

/**
 * A schema name is interpolated into DDL and into the libpq `options` string, neither of
 * which is parameterizable, so restrict it to an unquoted, injection-proof identifier.
 */
export function assertValidSchemaName(schema: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(
      `invalid test schema name ${JSON.stringify(schema)} — must match /^[a-z_][a-z0-9_]*$/`,
    );
  }
}

/**
 * The libpq `options` value that pins `search_path` at CONNECT time. `<schema>` is first so
 * unqualified `CREATE TABLE`/DML lands in the suite's private schema; `public` is kept on the
 * path so the DATABASE-scoped `vector` type (Gotcha 1) still resolves.
 */
export function searchPathOptions(schema: string): string {
  assertValidSchemaName(schema);
  return `-c search_path=${schema},public`;
}

/** A `PrismaPg` adapter whose EVERY pooled connection pins `search_path=<schema>,public`. */
export function schemaScopedAdapter(
  schema: string,
  databaseUrl: string = process.env.DATABASE_URL ?? "",
): PrismaPg {
  return new PrismaPg({ connectionString: databaseUrl, options: searchPathOptions(schema) });
}

/**
 * A `PrismaClient` pinned to `schema` on every connection. This is THE construction seam —
 * route every client a suite builds (observers, extra-pod clients, stealers, child-process
 * holders) through it so the schema pin cannot be forgotten on a pool that opens later
 * backends (Gotcha 2).
 */
export function makeSchemaScopedPrismaClient(
  schema: string,
  databaseUrl: string = process.env.DATABASE_URL ?? "",
): PrismaClient {
  return new PrismaClient({ adapter: schemaScopedAdapter(schema, databaseUrl) });
}

/**
 * Create the suite's private schema (dropped + recreated for a clean slate, so a re-run
 * never inherits a prior run's `rag_vectors` at a stale width) and ensure the DATABASE-scoped
 * `vector` extension exists in `public` (Gotcha 1). Call once, in `beforeAll`, BEFORE any
 * store runs its lazy `ensureSchema()`.
 *
 * Uses a short-lived admin client on the DEFAULT search_path so `CREATE EXTENSION` lands in
 * `public`, not in the test schema.
 */
export async function ensurePgTestSchema(
  schema: string,
  databaseUrl: string = process.env.DATABASE_URL ?? "",
): Promise<void> {
  assertValidSchemaName(schema);
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    // Database-scoped, in `public`; a no-op after the first suite creates it.
    await admin.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    // Fresh slate for this suite: no leftover tables, no stale vector width.
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.$disconnect();
  }
}
