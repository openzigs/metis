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
 * `stopBefore` hands back the database as it stood BEFORE a named migration, so
 * a test can insert rows in the old shape and then apply that migration — the
 * way a deployed database meets it. (`migrate deploy` runs over a copy of the
 * migrations directory holding only the migrations applied so far.) #2146 —
 * `globalSetup` snapshots one template per name in {@link STOP_BEFORE_MIGRATIONS}
 * on its way up the chain, so such a suite spawns the CLI only to apply the
 * migration under test, which real Prisma must do.
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
 * Hook budget for a `beforeAll` that calls {@link createMigratedSqlite}, or a test that
 * calls its `apply()` / `applyRemaining()`. The call itself copies a `globalSetup`
 * template (#1364, #2146); `apply()` and `applyRemaining()` still spawn the Prisma CLI,
 * whose duration grows with the migrations it applies and with CI's monorepo fan-out.
 * Under the default 10 s `hookTimeout` a full replay once timed out on CI (PR #242,
 * `agents-real-providers`); 120 s is the budget the suites that spawn `migrate deploy`
 * share (`ai-conversation.sqlite.test.ts`), in one place.
 */
export const MIGRATED_SQLITE_HOOK_TIMEOUT_MS = 120_000;

/**
 * #2146 — every `stopBefore` a suite passes, each a migration directory name. `globalSetup`
 * builds one template per entry, and {@link createMigratedSqlite} refuses a name missing
 * here rather than spawn the CLI for it inside the fan-out: a new migration test adds its
 * migration to this list.
 */
export const STOP_BEFORE_MIGRATIONS: readonly string[] = [
  "20260927000000_issue129_unified_agents_subagents",
  "20261001000000_issue369_issue_draft_dedup_unique",
  "20261003000457_issue457_repo_primary_unique",
  "20261004000474_issue474_document_source_title",
  "20261006000525_issue525_generated_source_by_id",
  "20261014000761_issue761_token_usage_cost_usd",
  "20261025001395_issue1395_user_identities",
  "20261028001447_issue1447_notification_project_id",
  "20261104001527_issue1527_product_home_workspace",
  "20261105001612_issue1612_requirement_kind",
  "20261106001618_issue1618_product_edge_coupling",
  "20261107001621_issue1621_portfolio_assessment",
  "20261109001624_issue1624_portfolio_report",
  "20261110001687_issue1687_product_edge_detected_classification",
  "20261111001725_issue1725_portfolio_host_product",
  "20261112001754_issue1754_impact_stored_link_seeds",
  "20261113001830_issue1830_code_citation_freshness",
  "20261113001835_issue1835_requirement_embeddings",
  "20261114001831_issue1831_citation_symbol_identity",
  "20261114001838_issue1838_requirement_similarity_dismissals",
  "20261115001839_issue1839_borrowed_citation_origin",
  "20261116001868_issue1868_governing_documents",
  "20261117001864_issue1864_document_updated_at",
  "20261117001870_issue1870_governing_rule_extraction",
  "20261118001947_issue1947_governing_extraction_retry_metering",
  "20261119001874_issue1874_governing_findings",
  "20261120001558_issue1558_audit_action_ts_index",
  "20261121002209_issue2209_requirement_picker_index",
  "20261122002218_issue2218_drop_requirement_project_index",
  "20261123002236_issue2236_clarification_records",
];

/** The database files `globalSetup` builds for workers to copy. */
export interface MigratedSqliteTemplates {
  /** The head schema: every migration applied. */
  head: string;
  /** Keyed by a {@link STOP_BEFORE_MIGRATIONS} name: every migration before it applied. */
  stopBefore: Record<string, string>;
}

/** The `provide`/`inject` key under which `globalSetup` hands workers the templates. */
export const MIGRATED_SQLITE_TEMPLATES_KEY = "migratedSqliteTemplates";

declare module "vitest" {
  interface ProvidedContext {
    migratedSqliteTemplates: MigratedSqliteTemplates;
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
 * Migrates the whole chain once into a fresh directory, snapshotting the database just
 * before each `stopBefore` migration on the way up: `globalSetup`'s templates, which
 * suites copy instead of spawning their own Prisma CLI. Each snapshot costs one CLI spawn
 * that applies only the migrations since the last, so the chain is still replayed once.
 */
export function buildMigratedSqliteTemplates(
  stopBefore: readonly string[] = STOP_BEFORE_MIGRATIONS,
): MigratedSqliteTemplates & { cleanup(): void } {
  const names = migrationNames();
  const unknown = stopBefore.filter((name) => !names.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `stopBefore names no migration in ${SQLITE_MIGRATIONS_DIR}: ${unknown.join(", ")}`,
    );
  }
  const stops = new Set(stopBefore);
  const dir = mkdtempSync(path.join(os.tmpdir(), "metis-migrated-template-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const ws = migrationWorkspace(dir);
    const snapshots: Record<string, string> = {};
    for (const name of names) {
      if (stops.has(name)) {
        ws.deploy();
        ws.assertComplete();
        const snapshot = path.join(dir, `before-${name}.db`);
        copyFileSync(ws.dbFile, snapshot);
        snapshots[name] = snapshot;
      }
      ws.copy(name);
    }
    ws.deploy();
    ws.assertComplete();
    return { head: ws.dbFile, stopBefore: snapshots, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * The template file a suite copies, out of what `globalSetup` provided. Under a config
 * without that `globalSetup` nothing was provided, and `inject()` returns `undefined`.
 */
export function migratedSqliteTemplate(
  provided: MigratedSqliteTemplates | undefined,
  stopBefore?: string,
): string {
  if (!provided) {
    throw new Error(
      "createMigratedSqlite found no migrated SQLite template: this vitest config does not " +
        "list tests/global-setup-migrated-sqlite.ts in `globalSetup` (vitest.config.ts does)",
    );
  }
  if (!stopBefore) return provided.head;
  if (!Object.hasOwn(provided.stopBefore, stopBefore)) {
    throw new Error(
      `no migrated SQLite template stops before ${stopBefore}: add it to ` +
        "STOP_BEFORE_MIGRATIONS in tests/helpers/sqlite-migrated-db.ts",
    );
  }
  return provided.stopBefore[stopBefore]!;
}

export function createMigratedSqlite(
  prefix: string,
  opts: { stopBefore?: string } = {},
): MigratedSqlite {
  const template = migratedSqliteTemplate(inject(MIGRATED_SQLITE_TEMPLATES_KEY), opts.stopBefore);
  const dir = mkdtempSync(path.join(os.tmpdir(), `metis-${prefix}-`));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let ws: ReturnType<typeof migrationWorkspace>;
  try {
    ws = migrationWorkspace(dir);
    for (const name of migrationNames()) {
      if (name === opts.stopBefore) break;
      ws.copy(name);
    }
    copyFileSync(template, ws.dbFile);
    ws.assertComplete();
  } catch (err) {
    // The suite never gets a handle to call cleanup() on, so the directory goes here.
    cleanup();
    throw err;
  }
  const { dbFile } = ws;
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
    cleanup,
  };
}
