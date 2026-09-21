/**
 * Provider-aware Prisma driver-adapter selection for the LOGICAL dump/reload
 * CLIs (Path B portability).
 *
 * The logical dump FORMAT is provider-neutral (see logical-dump.ts): the same
 * NDJSON + manifest can target SQLite or Postgres. The Prisma *driver adapter*,
 * however, is provider-specific:
 *
 *   - sqlite     → `@prisma/adapter-better-sqlite3` (a committed dependency;
 *                  also the runtime adapter, see lib/prisma.ts).
 *   - postgresql → `@prisma/adapter-pg`. This is INTENTIONALLY NOT a committed
 *                  dependency of this repo: METIS runs on SQLite at runtime and
 *                  shipping the pg adapter would add an unused heavy dependency.
 *                  The Postgres path is therefore "wired but opt-in": it is
 *                  resolved by a DYNAMIC import at run time, and if the package
 *                  is absent we FAIL LOUDLY with an actionable message rather
 *                  than silently falling back to SQLite (which would write the
 *                  dump into the wrong engine).
 *
 * This module is intentionally tiny and side-effect-free at import time so it is
 * unit-testable without a database or either adapter installed: the SQLite path
 * is exercised in CI; the Postgres path's "adapter absent" branch is unit-tested
 * by pointing the dynamic import at a guaranteed-missing module.
 */

import process from "node:process";

/** Normalized provider for adapter selection. */
export type LogicalProvider = "sqlite" | "postgresql";

/**
 * Resolve the configured provider from `DATABASE_PROVIDER`, defaulting to
 * `sqlite` to match `scripts/export.mjs` / `import.mjs`.
 */
export function resolveLogicalProvider(raw: string | undefined): LogicalProvider {
  const p = (raw ?? "sqlite").toLowerCase();
  return p === "postgres" || p === "postgresql" ? "postgresql" : "sqlite";
}

/**
 * Minimal shape of a Prisma driver adapter factory — enough to construct a
 * `PrismaClient({ adapter })`. We deliberately keep this `unknown`-ish so this
 * module needs neither adapter package's types at compile time.
 */
export type PrismaDriverAdapter = object;

/** The actionable message shown when the Postgres adapter is not installed. */
export const POSTGRES_ADAPTER_MISSING_MESSAGE =
  'Postgres logical reload requires "@prisma/adapter-pg", which is not installed ' +
  "in this environment. Install it in the target environment (e.g. `pnpm --filter " +
  "@metis/server add @prisma/adapter-pg`), then re-run. The dump format is " +
  "provider-neutral; SQLite→SQLite is exercised in CI, while the SQLite→Postgres " +
  "direction is wired but opt-in and not yet exercised in CI.";

/**
 * Default dynamic import of the OPTIONAL Postgres adapter. The module specifier
 * is built indirectly so TypeScript does NOT statically resolve `@prisma/
 * adapter-pg` (it is intentionally not a committed dependency); at runtime this
 * is a normal dynamic import that throws if the package is absent.
 */
function defaultImportPg(): Promise<unknown> {
  const spec = ["@prisma", "adapter-pg"].join("/");
  return import(/* @vite-ignore */ spec);
}

/**
 * Build a Prisma driver adapter for the given provider + connection URL.
 *
 * For `sqlite`, constructs the committed better-sqlite3 adapter (passed in by
 * the caller to avoid a static import here that the unit test would have to load
 * a DB for). For `postgresql`, DYNAMICALLY imports `@prisma/adapter-pg`; if that
 * import fails (package not installed), throws an Error carrying
 * {@link POSTGRES_ADAPTER_MISSING_MESSAGE}.
 *
 * @param provider    resolved provider
 * @param url         connection string
 * @param sqliteAdapterFactory  factory for the committed SQLite adapter — the
 *        caller supplies `(u) => new PrismaBetterSqlite3({ url: u })` so this
 *        module carries no static adapter import.
 * @param importPg    seam for the dynamic Postgres-adapter import (overridable
 *        in tests); defaults to importing "@prisma/adapter-pg".
 */
export async function createLogicalAdapter(
  provider: LogicalProvider,
  url: string,
  sqliteAdapterFactory: (url: string) => PrismaDriverAdapter,
  importPg: () => Promise<unknown> = defaultImportPg,
): Promise<PrismaDriverAdapter> {
  if (provider === "sqlite") {
    return sqliteAdapterFactory(url);
  }

  // provider === "postgresql": dynamic import so the dependency stays opt-in.
  let mod: Record<string, unknown>;
  try {
    mod = (await importPg()) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${POSTGRES_ADAPTER_MISSING_MESSAGE} (import error: ${detail})`);
  }

  const PrismaPg = (mod.PrismaPg ?? mod.default) as
    | (new (config: { connectionString: string }) => PrismaDriverAdapter)
    | undefined;
  if (typeof PrismaPg !== "function") {
    throw new Error(
      `${POSTGRES_ADAPTER_MISSING_MESSAGE} (resolved module did not export a PrismaPg adapter constructor)`,
    );
  }
  return new PrismaPg({ connectionString: url });
}

/**
 * Read + validate `DATABASE_URL` for an operation that connects to (and, on
 * import, MUTATES) a database. Unlike `scripts/export.mjs`, the logical CLIs do
 * NOT silently fall back to `file:./dev.db`: a missing URL on a mutating
 * operation is a configuration error and must fail fast.
 */
export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new Error(
      "DATABASE_URL is not set. The logical export/import operates on the database " +
        "named by DATABASE_URL and will NOT fall back to a default dev database " +
        "(an import MUTATES its target). Set DATABASE_URL explicitly, then re-run.",
    );
  }
  return url;
}
