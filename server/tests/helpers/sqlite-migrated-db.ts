/**
 * Epic #129 — a REAL SQLite database built from the real migration chain by the
 * real `prisma migrate deploy`, for tests that must read back through the
 * production queries (the "write the read cannot see" defect shape never
 * survives a real database).
 *
 * #1364 — the head schema is migrated ONCE per run, in `globalSetup`
 * (`tests/global-setup-migrated-sqlite.ts`), and each suite copies that file.
 * One Prisma CLI per suite (240-odd under the vitest fan-out) left a child
 * exiting non-zero with no Prisma error, and once handed a `beforeAll` a
 * database with no `users` table. Every database this helper returns is
 * checked against the migrations it should hold, so an incomplete one fails
 * loudly and names what is missing.
 *
 * `stopBefore` builds the database as it stood BEFORE a named migration, so a
 * test can insert rows in the old shape and then apply that migration — the
 * way a deployed database meets it. (`migrate deploy` runs over a copy of the
 * migrations directory holding only the migrations applied so far.) That path
 * still spawns the CLI per suite: the migration under test must be applied by
 * real Prisma.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { inject } from "vitest";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SQLITE_MIGRATIONS_DIR = path.join(SERVER_ROOT, "prisma", "migrations");

/**
 * Hook budget for a `beforeAll` that calls {@link createMigratedSqlite}. The hook
 * does real work — it spawns the Prisma CLI and replays the WHOLE migration chain
 * — so its duration grows with every migration and with CI's monorepo fan-out.
 * Under the default 10 s `hookTimeout` it passed locally (~3 s) and timed out on
 * CI once #149 added one more migration (PR #242, `agents-real-providers`). The
 * other suites that run `migrate deploy` in a hook already declare 120 s
 * (`ai-conversation.sqlite.test.ts`); this is that budget, in one place.
 */
export const MIGRATED_SQLITE_HOOK_TIMEOUT_MS = 120_000;

/** The `provide`/`inject` key under which `globalSetup` hands workers the template's path. */
export const MIGRATED_SQLITE_TEMPLATE_KEY = "migratedSqliteTemplate";

declare module "vitest" {
  interface ProvidedContext {
    migratedSqliteTemplate: string;
  }
}

export interface MigratedSqlite {
  dir: string;
  dbFile: string;
  url: string;
  /** Apply one more migration (by directory name) with `prisma migrate deploy`. */
  apply(migration: string): void;
  /**
   * Apply every migration not yet applied, bringing the file to the head schema.
   * A test that drives CURRENT code (whose Prisma client selects every column)
   * against a `stopBefore` database needs this once its migration-specific
   * assertions are set up — otherwise any later column breaks it (#733).
   */
  applyRemaining(): void;
  /** Run one raw SQL statement against the file (legacy-shape inserts). */
  exec(sql: string, params?: unknown[]): void;
  cleanup(): void;
}

function migrationNames(): string[] {
  return readdirSync(SQLITE_MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * Throws unless `dbFile` records every migration in `expected` as applied: finished and
 * not rolled back. `migrate deploy` exiting 0 is not the proof; #1364's empty database was.
 */
export function assertMigrationsApplied(dbFile: string, expected: readonly string[]): void {
  const done = existsSync(dbFile) ? appliedMigrations(dbFile) : new Set<string>();
  const missing = expected.filter((name) => !done.has(name));
  if (missing.length > 0) {
    throw new Error(
      `migrated SQLite ${dbFile} is incomplete: ${expected.length - missing.length} of ` +
        `${expected.length} migrations applied; missing: ${missing.join(", ")}`,
    );
  }
}

function appliedMigrations(dbFile: string): Set<string> {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'")
      .get();
    const rows = hasTable
      ? (db
          .prepare(
            "SELECT migration_name FROM _prisma_migrations " +
              "WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
          )
          .all() as { migration_name: string }[])
      : [];
    return new Set(rows.map((r) => r.migration_name));
  } finally {
    db.close();
  }
}

const tail = (out: unknown): string =>
  String(out ?? "")
    .trim()
    .slice(-2_000);

/** A migrations directory, its `prisma.config.ts` and the database file, under `dir`. */
function migrationWorkspace(dir: string) {
  const dbFile = path.join(dir, "test.db");
  const migrations = path.join(dir, "migrations");
  mkdirSync(migrations);
  copyFileSync(
    path.join(SQLITE_MIGRATIONS_DIR, "migration_lock.toml"),
    path.join(migrations, "migration_lock.toml"),
  );
  const config = path.join(dir, "prisma.config.ts");
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      schema: path.join(SERVER_ROOT, "prisma", "schema.prisma"),
      migrations: { path: migrations },
      datasource: { url: `file:${dbFile}` },
    })};\n`,
  );
  const isCopied = (name: string) => existsSync(path.join(migrations, name));
  return {
    dbFile,
    isCopied,
    copy: (name: string) =>
      cpSync(path.join(SQLITE_MIGRATIONS_DIR, name), path.join(migrations, name), {
        recursive: true,
      }),
    /** The database must hold every migration copied so far: checked, not assumed. */
    assertComplete: () => assertMigrationsApplied(dbFile, migrationNames().filter(isCopied)),
    deploy: () => {
      try {
        execFileSync(
          process.execPath,
          [
            path.join(SERVER_ROOT, "node_modules", "prisma", "build", "index.js"),
            "migrate",
            "deploy",
            "--config",
            config,
          ],
          { cwd: dir, env: { ...process.env, DATABASE_URL: `file:${dbFile}` }, stdio: "pipe" },
        );
      } catch (err) {
        // Node's own message carries stderr only, which a killed child leaves holding just
        // Prisma's banner (#1364): name the status, the signal and the stdout progress too.
        const e = err as {
          status?: number | null;
          signal?: string | null;
          stdout?: unknown;
          stderr?: unknown;
        };
        throw new Error(
          `prisma migrate deploy failed for ${dbFile} (status ${e.status ?? null}, ` +
            `signal ${e.signal ?? null})\n--- stdout ---\n${tail(e.stdout)}\n` +
            `--- stderr ---\n${tail(e.stderr)}`,
          { cause: err },
        );
      }
    },
  };
}

/**
 * Migrates the whole chain once into a fresh directory: `globalSetup`'s template, which
 * every head-schema suite copies instead of spawning its own Prisma CLI.
 */
export function buildMigratedSqliteTemplate(): { dbFile: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "metis-migrated-template-"));
  const ws = migrationWorkspace(dir);
  for (const name of migrationNames()) ws.copy(name);
  ws.deploy();
  ws.assertComplete();
  return { dbFile: ws.dbFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function createMigratedSqlite(
  prefix: string,
  opts: { stopBefore?: string } = {},
): MigratedSqlite {
  const dir = mkdtempSync(path.join(os.tmpdir(), `metis-${prefix}-`));
  const ws = migrationWorkspace(dir);
  const { dbFile } = ws;
  if (opts.stopBefore) {
    for (const name of migrationNames()) {
      if (name === opts.stopBefore) break;
      ws.copy(name);
    }
    ws.deploy();
  } else {
    for (const name of migrationNames()) ws.copy(name);
    copyFileSync(inject(MIGRATED_SQLITE_TEMPLATE_KEY), dbFile);
  }
  ws.assertComplete();
  return {
    dir,
    dbFile,
    url: `file:${dbFile}`,
    apply: (name) => {
      ws.copy(name);
      ws.deploy();
      ws.assertComplete();
    },
    applyRemaining: () => {
      for (const name of migrationNames()) {
        if (!ws.isCopied(name)) ws.copy(name);
      }
      ws.deploy();
      ws.assertComplete();
    },
    exec: (sql, params = []) => {
      const db = new Database(dbFile);
      try {
        db.prepare(sql).run(...params);
      } finally {
        db.close();
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
