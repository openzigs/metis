/**
 * Epic #129 — a REAL SQLite database built from the real migration chain by the
 * real `prisma migrate deploy`, for tests that must read back through the
 * production queries (the "write the read cannot see" defect shape never
 * survives a real database).
 *
 * `stopBefore` builds the database as it stood BEFORE a named migration, so a
 * test can insert rows in the old shape and then apply that migration — the
 * way a deployed database meets it. (`migrate deploy` runs over a copy of the
 * migrations directory holding only the migrations applied so far.)
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
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

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SQLITE_MIGRATIONS_DIR = path.join(SERVER_ROOT, "prisma", "migrations");

export interface MigratedSqlite {
  dir: string;
  dbFile: string;
  url: string;
  /** Apply one more migration (by directory name) with `prisma migrate deploy`. */
  apply(migration: string): void;
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

export function createMigratedSqlite(
  prefix: string,
  opts: { stopBefore?: string } = {},
): MigratedSqlite {
  const dir = mkdtempSync(path.join(os.tmpdir(), `metis-${prefix}-`));
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
  const deploy = () =>
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
  const copy = (name: string) =>
    cpSync(path.join(SQLITE_MIGRATIONS_DIR, name), path.join(migrations, name), {
      recursive: true,
    });
  for (const name of migrationNames()) {
    if (opts.stopBefore && name === opts.stopBefore) break;
    copy(name);
  }
  deploy();
  return {
    dir,
    dbFile,
    url: `file:${dbFile}`,
    apply: (name) => {
      copy(name);
      deploy();
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
