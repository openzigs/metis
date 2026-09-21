/**
 * Integration test for the sqlite path-resolution data-loss fix.
 *
 * Bug: backup.sh / restore.sh resolved a relative `file:` sqlite URL to
 * `server/prisma/<rel>` (a stale 0-byte file) instead of `server/<rel>` (the
 * real DB the app opens, because the better-sqlite3 adapter resolves relative
 * file: URLs against process.cwd() and the server runs from server/). Result:
 * backups captured an EMPTY db and restores wrote where the app never reads.
 *
 * This test exercises the REAL scripts. To make REPO_ROOT (derived inside the
 * scripts from ${BASH_SOURCE[0]}/..) point at a throwaway layout, we copy the
 * actual backup.sh / restore.sh into <tmp>/scripts/ and run them there with
 * DATABASE_URL=file:./dev.db. Their own resolution logic then runs unmodified.
 */
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(here, ".."); // .../scripts
const BACKUP_SH = path.join(SCRIPTS_DIR, "backup.sh");
const RESTORE_SH = path.join(SCRIPTS_DIR, "restore.sh");

function hasSqlite3(): boolean {
  const r = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}
const SQLITE3 = hasSqlite3();

/** Run a sqlite3 statement against a db file. */
function sqlite(dbPath: string, sql: string): string {
  return execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).trim();
}

/** Build a throwaway repo layout: <tmp>/{scripts,server,package.json}. */
function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metis-bkrs-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  // package.json is read by backup.sh for the manifest schemaVersion.
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "metis-test", version: "9.9.9" }),
  );
  // Copy the REAL scripts so their REPO_ROOT (= scriptdir/..) resolves to <root>.
  fs.copyFileSync(BACKUP_SH, path.join(root, "scripts", "backup.sh"));
  fs.copyFileSync(RESTORE_SH, path.join(root, "scripts", "restore.sh"));
  fs.chmodSync(path.join(root, "scripts", "backup.sh"), 0o755);
  fs.chmodSync(path.join(root, "scripts", "restore.sh"), 0o755);
  return root;
}

/** Seed <root>/server/dev.db with a couple of tables + rows. */
function seedDb(root: string): void {
  const db = path.join(root, "server", "dev.db");
  sqlite(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
  sqlite(db, "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);");
  sqlite(db, "INSERT INTO users (name) VALUES ('alice'), ('bob'), ('carol');");
  sqlite(db, "INSERT INTO notes (body) VALUES ('one'), ('two');");
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(
  script: string,
  root: string,
  args: string[],
  env: Record<string, string>,
): RunResult {
  const r = spawnSync("bash", [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: "file:./dev.db",
      DATABASE_PROVIDER: "sqlite",
      BACKUP_RETENTION_DAYS: "0",
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe.skipIf(!SQLITE3)("backup/restore sqlite path resolution", () => {
  it("backup resolves to server/dev.db (NOT server/prisma) and captures tables > 0", () => {
    const root = makeRepo();
    seedDb(root);
    const outDir = path.join(root, "backups");

    const res = runScript(path.join(root, "scripts", "backup.sh"), root, [outDir], {});
    expect(res.status).toBe(0);

    // stdout must surface the resolved source path, pointing at server/ not server/prisma.
    // The relative path "./dev.db" is joined as "$REPO_ROOT/server/./dev.db".
    expect(res.stdout).toContain(`[backup] sqlite source: ${root}/server/./dev.db`);
    expect(res.stdout).not.toContain(path.join("server", "prisma"));

    // The tarball's db/metis.sqlite must contain the seeded tables.
    const tarball = fs.readdirSync(outDir).find((f) => f.endsWith(".tar.gz"))!;
    expect(tarball).toBeTruthy();
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "metis-extract-"));
    execFileSync("tar", ["-xzf", path.join(outDir, tarball), "-C", extractDir]);
    const captured = path.join(extractDir, "db", "metis.sqlite");
    expect(fs.existsSync(captured)).toBe(true);
    const tableCount = Number(
      sqlite(captured, "SELECT count(*) FROM sqlite_master WHERE type='table'"),
    );
    expect(tableCount).toBeGreaterThan(0);
    expect(Number(sqlite(captured, "SELECT count(*) FROM users"))).toBe(3);
  });

  it("restore writes back to server/dev.db, NOT server/prisma/dev.db", () => {
    const root = makeRepo();
    seedDb(root);
    const outDir = path.join(root, "backups");
    expect(runScript(path.join(root, "scripts", "backup.sh"), root, [outDir], {}).status).toBe(0);
    const tarball = path.join(outDir, fs.readdirSync(outDir).find((f) => f.endsWith(".tar.gz"))!);

    // Wipe the real DB so we can prove restore re-creates it at server/dev.db.
    fs.rmSync(path.join(root, "server", "dev.db"));

    const res = runScript(path.join(root, "scripts", "restore.sh"), root, [tarball], {});
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`[restore] sqlite target: ${root}/server/./dev.db`);

    // Real path restored; stale prisma path NOT created.
    expect(fs.existsSync(path.join(root, "server", "dev.db"))).toBe(true);
    expect(fs.existsSync(path.join(root, "server", "prisma", "dev.db"))).toBe(false);
  });

  it("round-trips row counts: populate -> backup -> modify -> restore -> match", () => {
    const root = makeRepo();
    seedDb(root);
    const dbPath = path.join(root, "server", "dev.db");
    const originalUsers = Number(sqlite(dbPath, "SELECT count(*) FROM users"));
    const originalNotes = Number(sqlite(dbPath, "SELECT count(*) FROM notes"));

    const outDir = path.join(root, "backups");
    expect(runScript(path.join(root, "scripts", "backup.sh"), root, [outDir], {}).status).toBe(0);
    const tarball = path.join(outDir, fs.readdirSync(outDir).find((f) => f.endsWith(".tar.gz"))!);

    // Mutate the source AFTER the backup.
    sqlite(dbPath, "DELETE FROM users;");
    sqlite(dbPath, "INSERT INTO notes (body) VALUES ('extra');");
    expect(Number(sqlite(dbPath, "SELECT count(*) FROM users"))).toBe(0);

    expect(runScript(path.join(root, "scripts", "restore.sh"), root, [tarball], {}).status).toBe(0);

    // After restore the source matches the original snapshot.
    expect(Number(sqlite(dbPath, "SELECT count(*) FROM users"))).toBe(originalUsers);
    expect(Number(sqlite(dbPath, "SELECT count(*) FROM notes"))).toBe(originalNotes);
  });

  it("empty-DB warning fires loudly on stderr but exit code stays 0", () => {
    const root = makeRepo();
    // Create an empty (0-table) db at the real path.
    sqlite(path.join(root, "server", "dev.db"), "VACUUM;");
    expect(
      Number(
        sqlite(
          path.join(root, "server", "dev.db"),
          "SELECT count(*) FROM sqlite_master WHERE type='table'",
        ),
      ),
    ).toBe(0);

    const outDir = path.join(root, "backups");
    const res = runScript(path.join(root, "scripts", "backup.sh"), root, [outDir], {});

    // Non-fatal: a legitimately empty DB is allowed.
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("WARNING");
    expect(res.stderr).toContain("EMPTY (0 tables)");
    expect(res.stderr).toContain("!!!");
  });

  it("still hard-fails when the sqlite file is missing entirely", () => {
    const root = makeRepo(); // no seedDb -> server/dev.db absent
    const outDir = path.join(root, "backups");
    const res = runScript(path.join(root, "scripts", "backup.sh"), root, [outDir], {});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("sqlite db not found");
    expect(res.stderr).toContain(`${root}/server/./dev.db`);
  });

  it("absolute file: paths are used verbatim (not re-rooted under server/)", () => {
    const root = makeRepo();
    // Put the DB at an absolute location OUTSIDE server/.
    const absDb = path.join(root, "external.db");
    sqlite(absDb, "CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);");
    const outDir = path.join(root, "backups");

    const res = runScript(path.join(root, "scripts", "backup.sh"), root, [outDir], {
      DATABASE_URL: `file:${absDb}`,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`[backup] sqlite source: ${absDb}`);
    // Absolute path must NOT be re-rooted under server/.
    expect(res.stdout).not.toContain(path.join(root, "server", absDb));
  });
});
