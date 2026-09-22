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
 *
 * Issue #45 — the adapter is half of it. A generated Prisma client is bound to ONE
 * provider (its `activeProvider`) and refuses a driver adapter for the other, so the
 * CLIENT must be chosen by the same rule. In dev there is one client and you
 * `prisma generate` for the database you run. The production image ships two: the
 * default (SQLite) client at `@prisma/client`, and a Postgres client generated to
 * the directory {@link POSTGRES_CLIENT_ENV} names (`Dockerfile.server`). See
 * {@link resolvePrismaClientClass}.
 */
import { createRequire } from "node:module";
import path from "node:path";

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
 * Environment variable naming a directory that holds a Prisma client generated
 * from `prisma/postgres/schema.prisma`. When set, a Postgres `DATABASE_URL` uses
 * that client instead of `@prisma/client` (#45).
 */
export const POSTGRES_CLIENT_ENV = "METIS_PRISMA_CLIENT_POSTGRESQL";

type PrismaClientClass = typeof PrismaClient;

/**
 * Choose the generated Prisma client class for a provider (#45).
 *
 * - `postgresql` with {@link POSTGRES_CLIENT_ENV} set: the client in that directory.
 *   It must be absolute — `require` would otherwise resolve it against THIS module's
 *   directory, not the working directory an operator would assume.
 * - anything else: `@prisma/client`, i.e. whatever `prisma generate` last produced.
 *
 * A directory that cannot be loaded, or that exports no `PrismaClient`, fails loud
 * at startup rather than falling back to a client for the other provider, which
 * would only fail later with Prisma's less specific adapter-mismatch error.
 *
 * Both clients import the same `@prisma/client/runtime`, so `Prisma.*` error
 * classes and sentinels (`Prisma.JsonNull`, `Prisma.Decimal`) are the same objects
 * whichever client is in use (measured in the image).
 */
export function resolvePrismaClientClass(
  provider: DatabaseProvider,
  env: NodeJS.ProcessEnv = process.env,
  load: (id: string) => unknown = createRequire(import.meta.url),
): PrismaClientClass {
  const dir = provider === "postgresql" ? env[POSTGRES_CLIENT_ENV]?.trim() : undefined;
  if (!dir) return PrismaClient;
  if (!path.isAbsolute(dir)) {
    throw new Error(`${POSTGRES_CLIENT_ENV} must be an absolute path, got "${dir}".`);
  }
  let mod: unknown;
  try {
    mod = load(dir);
  } catch (err) {
    throw new Error(
      `${POSTGRES_CLIENT_ENV}=${dir}: cannot load the Postgres Prisma client: ${(err as Error).message}`,
    );
  }
  const cls = (mod as { PrismaClient?: unknown } | null)?.PrismaClient;
  if (typeof cls !== "function") {
    throw new Error(`${POSTGRES_CLIENT_ENV}=${dir} exports no PrismaClient.`);
  }
  return cls as PrismaClientClass;
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
const PrismaClientForProvider = resolvePrismaClientClass(resolveDatabaseProvider(boundDatabaseUrl));

export const prisma: PrismaClient =
  globalThis.__metisPrisma ??
  new PrismaClientForProvider({
    adapter,
    log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__metisPrisma = prisma;
}

export type { PrismaClient } from "@prisma/client";
export { Prisma } from "@prisma/client";
