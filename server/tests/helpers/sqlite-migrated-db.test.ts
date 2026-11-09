/**
 * #1364 — `createMigratedSqlite` hands every suite a database that is complete before its
 * `beforeAll` uses it.
 *
 * Under the monorepo fan-out a `prisma migrate deploy` child exited non-zero with no Prisma
 * error (a child killed under load prints nothing), and once a suite's `beforeAll` met a
 * database with no `users` table. The head schema is now migrated ONCE, by the real Prisma
 * CLI, in `globalSetup` (`tests/global-setup-migrated-sqlite.ts`), and each suite copies that
 * file; every database the helper returns is checked against the migrations it should hold.
 */
import * as childProcess from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, inject, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ calls: 0, fail: null as unknown, noop: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof childProcess>();
  return {
    ...real,
    execFileSync: (...args: Parameters<typeof real.execFileSync>) => {
      spawned.calls += 1;
      if (spawned.fail) {
        const err = spawned.fail;
        spawned.fail = null;
        throw err;
      }
      // A deploy that exits 0 having applied nothing: the shape behind #1364's empty database.
      if (spawned.noop) return Buffer.from("");
      return real.execFileSync(...args);
    },
  };
});

const {
  assertMigrationsApplied,
  createMigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
  MIGRATED_SQLITE_TEMPLATE_KEY,
  SQLITE_MIGRATIONS_DIR,
} = await import("./sqlite-migrated-db.js");
const { default: globalSetup } = await import("../global-setup-migrated-sqlite.js");

const ALL = readdirSync(SQLITE_MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const LAST = ALL[ALL.length - 1]!;

const tables = (dbFile: string): string[] => {
  const db = new Database(dbFile, { readonly: true });
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
  } finally {
    db.close();
  }
};
const applied = (dbFile: string): string[] => {
  const db = new Database(dbFile, { readonly: true });
  try {
    return (
      db.prepare("SELECT migration_name FROM _prisma_migrations ORDER BY migration_name").all() as {
        migration_name: string;
      }[]
    ).map((r) => r.migration_name);
  } finally {
    db.close();
  }
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  spawned.calls = 0;
  spawned.fail = null;
  spawned.noop = false;
});
const scratchCopy = (from: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "metis-1364-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "copy.db");
  copyFileSync(from, file);
  return file;
};

describe("#1364 — createMigratedSqlite", () => {
  it("copies the globalSetup template for the head schema, spawning no Prisma CLI", () => {
    const sqlite = createMigratedSqlite("1364-head");
    cleanups.push(() => sqlite.cleanup());

    expect(spawned.calls).toBe(0);
    expect(tables(sqlite.dbFile)).toContain("users");
    expect(applied(sqlite.dbFile)).toEqual(ALL);

    // A suite's writes land in its own copy, never in the template every suite copies.
    const template = inject(MIGRATED_SQLITE_TEMPLATE_KEY);
    expect(sqlite.dbFile).not.toBe(template);
    sqlite.exec("CREATE TABLE only_in_this_suite (id INTEGER)");
    expect(tables(sqlite.dbFile)).toContain("only_in_this_suite");
    expect(tables(template)).not.toContain("only_in_this_suite");
  });

  it(
    "still builds a stopBefore database with the real CLI, and apply() completes it",
    () => {
      const sqlite = createMigratedSqlite("1364-stop", { stopBefore: LAST });
      cleanups.push(() => sqlite.cleanup());
      expect(spawned.calls).toBe(1);
      expect(applied(sqlite.dbFile)).toEqual(ALL.slice(0, -1));

      sqlite.apply(LAST);
      expect(spawned.calls).toBe(2);
      expect(applied(sqlite.dbFile)).toEqual(ALL);
    },
    MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
  );

  it(
    "applyRemaining() brings a stopBefore database to the head schema",
    () => {
      const sqlite = createMigratedSqlite("1364-remaining", { stopBefore: ALL[ALL.length - 2] });
      cleanups.push(() => sqlite.cleanup());
      expect(applied(sqlite.dbFile)).toEqual(ALL.slice(0, -2));
      sqlite.applyRemaining();
      expect(applied(sqlite.dbFile)).toEqual(ALL);
    },
    MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
  );

  it("names the exit status, the signal and the CLI's stdout when migrate deploy fails", () => {
    spawned.fail = Object.assign(new Error("Command failed: prisma migrate deploy"), {
      status: null,
      signal: "SIGKILL",
      stdout: Buffer.from('Datasource "db": SQLite database\n182 migrations found\n'),
      stderr: Buffer.from("Loaded Prisma config from prisma.config.ts.\n"),
    });
    let message = "";
    try {
      createMigratedSqlite("1364-killed", { stopBefore: LAST });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("prisma migrate deploy failed");
    expect(message).toContain("signal SIGKILL");
    expect(message).toContain("status null");
    expect(message).toContain("182 migrations found");
    expect(message).toContain("Loaded Prisma config");
  });

  it("refuses a stopBefore database that a deploy reported built but never wrote", () => {
    spawned.noop = true;
    expect(() => createMigratedSqlite("1364-unwritten", { stopBefore: LAST })).toThrow(
      new RegExp(`is incomplete: 0 of ${ALL.length - 1} migrations applied`),
    );
  });

  it(
    "refuses an apply() whose deploy exited 0 without applying the migration",
    () => {
      const sqlite = createMigratedSqlite("1364-apply-noop", { stopBefore: LAST });
      cleanups.push(() => sqlite.cleanup());
      spawned.noop = true;
      expect(() => sqlite.apply(LAST)).toThrow(new RegExp(`missing: ${LAST}`));
    },
    MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
  );
});

describe("#1364 — assertMigrationsApplied", () => {
  const template = () => inject(MIGRATED_SQLITE_TEMPLATE_KEY);

  it("accepts a database holding every expected migration", () => {
    expect(() => assertMigrationsApplied(template(), ALL)).not.toThrow();
  });

  it("refuses a database missing a migration, and names it", () => {
    const file = scratchCopy(template());
    const db = new Database(file);
    db.prepare("DELETE FROM _prisma_migrations WHERE migration_name = ?").run(LAST);
    db.close();
    expect(() => assertMigrationsApplied(file, ALL)).toThrow(
      new RegExp(`${ALL.length - 1} of ${ALL.length} migrations applied.*missing: ${LAST}`, "s"),
    );
  });

  it("refuses a migration Prisma started but never finished", () => {
    const file = scratchCopy(template());
    const db = new Database(file);
    db.prepare("UPDATE _prisma_migrations SET finished_at = NULL WHERE migration_name = ?").run(
      LAST,
    );
    db.close();
    expect(() => assertMigrationsApplied(file, ALL)).toThrow(new RegExp(`missing: ${LAST}`));
  });

  it("refuses a rolled-back migration", () => {
    const file = scratchCopy(template());
    const db = new Database(file);
    db.prepare(
      "UPDATE _prisma_migrations SET rolled_back_at = finished_at WHERE migration_name = ?",
    ).run(LAST);
    db.close();
    expect(() => assertMigrationsApplied(file, ALL)).toThrow(new RegExp(`missing: ${LAST}`));
  });

  it("refuses an empty database — the 'no users table' shape", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "metis-1364-empty-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "empty.db");
    new Database(file).close();
    expect(() => assertMigrationsApplied(file, ALL)).toThrow(
      new RegExp(`0 of ${ALL.length} migrations applied`),
    );
  });
});

describe("#1364 — globalSetup", () => {
  it(
    "migrates one complete template, provides its path, and removes it on teardown",
    async () => {
      const provide = vi.fn();
      const teardown = await globalSetup({ provide } as never);
      expect(provide).toHaveBeenCalledWith(MIGRATED_SQLITE_TEMPLATE_KEY, expect.any(String));
      const file = provide.mock.calls[0]![1] as string;
      expect(applied(file)).toEqual(ALL);
      expect(tables(file)).toContain("users");

      teardown();
      expect(existsSync(file)).toBe(false);
      expect(existsSync(path.dirname(file))).toBe(false);
    },
    MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
  );
});
