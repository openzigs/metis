/**
 * Singleton Prisma client. Reuses the same instance across hot-reloads in
 * development and is mockable in tests via `vi.mock("./prisma.js")`.
 *
 * Issue #539 (epic #518) — the runtime adapter is selected by the
 * `DATABASE_URL` scheme so the server can be backed by a *shared* Postgres
 * instance (required for N>1 replicas) instead of always using an embedded,
 * per-pod SQLite file on an RWO PVC:
 *
 *   - `postgres://` / `postgresql://`  -> `@prisma/adapter-pg`  (PrismaPg)
 *   - `file:` / `sqlite:` (or unset)   -> `@prisma/adapter-better-sqlite3`
 *   - anything else                    -> fail loud
 *
 * This must stay in lock-step with `scripts/dev-server-entrypoint.sh`, which
 * picks the matching `prisma/postgres/schema.prisma` migrate target by the same
 * scheme rule.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/**
 * Either concrete driver-adapter factory this module can build. Both implement
 * Prisma's `SqlMigrationAwareDriverAdapterFactory`; using the union of the two
 * concrete classes keeps us off Prisma's internal `runtime/library` type path.
 */
type PrismaAdapterFactory = PrismaPg | PrismaBetterSqlite3;

declare global {
  var __metisPrisma: PrismaClient | undefined;
}

/** Default SQLite location when `DATABASE_URL` is unset. */
export const DEFAULT_SQLITE_URL = "file:./dev.db";

/** Database backend a `DATABASE_URL` scheme maps to. */
export type DatabaseProvider = "postgresql" | "sqlite";

/**
 * Classify a `DATABASE_URL` by its scheme.
 *
 * Mirrors the `case` in `scripts/dev-server-entrypoint.sh`: `postgres://` and
 * `postgresql://` are Postgres; `file:` / `sqlite:` are SQLite. An unrecognized
 * scheme throws so misconfiguration fails loud at startup rather than silently
 * defaulting to embedded SQLite (the bug this issue fixes).
 */
export function resolveDatabaseProvider(
  databaseUrl: string = process.env.DATABASE_URL || DEFAULT_SQLITE_URL,
): DatabaseProvider {
  const url = databaseUrl.trim();
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return "postgresql";
  }
  if (url.startsWith("file:") || url.startsWith("sqlite:")) {
    return "sqlite";
  }
  throw new Error(
    `Unsupported DATABASE_URL scheme: "${redactDatabaseUrl(url)}". ` +
      `Expected one of: postgres://, postgresql://, file:, sqlite:.`,
  );
}

/**
 * Build the Prisma driver-adapter factory for the given `DATABASE_URL`,
 * selecting the backend by scheme. Construction is lazy — neither adapter opens
 * a connection here — so this is safe to call in unit tests.
 */
export function selectPrismaAdapter(
  databaseUrl: string = process.env.DATABASE_URL || DEFAULT_SQLITE_URL,
): PrismaAdapterFactory {
  const provider = resolveDatabaseProvider(databaseUrl);
  if (provider === "postgresql") {
    return new PrismaPg({ connectionString: databaseUrl });
  }
  return new PrismaBetterSqlite3({ url: databaseUrl });
}

/**
 * Strip credentials from a `DATABASE_URL` for safe logging / error messages.
 * `postgres://user:pass@host/db` -> `postgres://host/db`.
 */
export function redactDatabaseUrl(databaseUrl: string): string {
  // Credentials only ever appear in a `//user:pass@host` authority segment.
  // URLs without one (e.g. `file:./dev.db`) have nothing to redact, and round-
  // tripping them through `URL` would mangle them (`file:./x` -> `file:///x`).
  if (!databaseUrl.includes("@")) {
    return databaseUrl;
  }
  // Strip the `user:pass@` segment of the authority without otherwise rewriting
  // the URL (avoids `URL`-normalization surprises).
  return databaseUrl.replace(/\/\/[^/@]*@/, "//");
}

/**
 * The `DATABASE_URL` the module-scope {@link prisma} client was actually built
 * against, captured at load (#1338).
 *
 * `process.env.DATABASE_URL` is NOT this value. The adapter is constructed once,
 * at module load; a later assignment to the environment variable changes the
 * variable and nothing else. An eval harness that repoints `DATABASE_URL` at a
 * throwaway SQLite file AFTER something has already imported this module keeps
 * writing to whatever was configured first — a developer's `dev.db`. Reading
 * this constant is how a caller can tell the two apart; comparing the
 * environment variable to its own intent cannot.
 */
export const boundDatabaseUrl: string = process.env.DATABASE_URL || DEFAULT_SQLITE_URL;

const adapter = selectPrismaAdapter(boundDatabaseUrl);

export const prisma: PrismaClient =
  globalThis.__metisPrisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__metisPrisma = prisma;
}

export type { PrismaClient } from "@prisma/client";
export { Prisma } from "@prisma/client";
