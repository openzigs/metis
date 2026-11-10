/**
 * #1364 — `createMigratedSqlite` hands every suite a database that is complete before its
 * `beforeAll` uses it.
 *
 * Under the monorepo fan-out a `prisma migrate deploy` child exited non-zero with no Prisma
 * error (a child killed under load prints nothing), and once a suite's `beforeAll` met a
 * database with no `users` table. The schema is now migrated ONCE, by the real Prisma CLI,
 * in `globalSetup` (`tests/global-setup-migrated-sqlite.ts`), and each suite copies a
 * template; every database the helper returns is checked against the migrations it should
 * hold. #2146 — that includes one template per `stopBefore`, so a migration suite spawns
 * the CLI only to apply the migration under test.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
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

// Records every directory the helper creates, and can fail its next file copy.
const files = vi.hoisted(() => ({ made: [] as string[], failCopy: false }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    mkdtempSync: (...args: Parameters<typeof real.mkdtempSync>) => {
      const dir = real.mkdtempSync(...args) as string;
      files.made.push(dir);
      return dir;
    },
    copyFileSync: (...args: Parameters<typeof real.copyFileSync>) => {
      if (files.failCopy) {
        files.failCopy = false;
        throw Object.assign(new Error("ENOSPC: no space left on device, copyfile"), {
          code: "ENOSPC",
        });
      }
      return real.copyFileSync(...args);
    },
  };
});

const {
  assertMigrationsApplied,
  buildMigratedSqliteTemplates,
  createMigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
  MIGRATED_SQLITE_TEMPLATES_KEY,
  migratedSqliteTemplate,
  SQLITE_MIGRATIONS_DIR,
  STOP_BEFORE_MIGRATIONS,
} = await import("./sqlite-migrated-db.js");

const ALL = readdirSync(SQLITE_MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const LAST = ALL[ALL.length - 1]!;
/** Every migration before `name`, in order. */
const before = (name: string): string[] => ALL.slice(0, ALL.indexOf(name));
/** A listed stopBefore with migrations after it, and a real migration that is not listed. */
const STOP = STOP_BEFORE_MIGRATIONS[STOP_BEFORE_MIGRATIONS.length - 2]!;
const UNLISTED = ALL.find((name) => !STOP_BEFORE_MIGRATIONS.includes(name))!;

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
  files.made.length = 0;
  files.failCopy = false;
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
    const template = inject(MIGRATED_SQLITE_TEMPLATES_KEY).head;
    expect(sqlite.dbFile).not.toBe(template);
    sqlite.exec("CREATE TABLE only_in_this_suite (id INTEGER)");
    expect(tables(sqlite.dbFile)).toContain("only_in_this_suite");
    expect(tables(template)).not.toContain("only_in_this_suite");
  });

  it(
    "#2146 copies a stopBefore template, spawning the CLI only for apply()",
    () => {
      const sqlite = createMigratedSqlite("2146-stop", { stopBefore: STOP });
      cleanups.push(() => sqlite.cleanup());
      expect(spawned.calls).toBe(0);
      expect(applied(sqlite.dbFile)).toEqual(before(STOP));
      expect(sqlite.dbFile).not.toBe(inject(MIGRATED_SQLITE_TEMPLATES_KEY).stopBefore[STOP]);

      sqlite.apply(STOP);
      expect(spawned.calls).toBe(1);
      expect(applied(sqlite.dbFile)).toEqual(ALL.slice(0, ALL.indexOf(STOP) + 1));
    },
    MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
  );

  it(
    "applyRemaining() brings a stopBefore database to the head schema",
    () => {
      const sqlite = createMigratedSqlite("1364-remaining", { stopBefore: STOP });
      cleanups.push(() => sqlite.cleanup());
      sqlite.applyRemaining();
      expect(spawned.calls).toBe(1);
      expect(applied(sqlite.dbFile)).toEqual(ALL);
    },
    MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
  );

  it("#2146 refuses a stopBefore with no template, naming the list to add it to", () => {
    expect(() => createMigratedSqlite("2146-unlisted", { stopBefore: UNLISTED })).toThrow(
      new RegExp(
        `no migrated SQLite template stops before ${UNLISTED}: add it to STOP_BEFORE_MIGRATIONS`,
      ),
    );
    expect(spawned.calls).toBe(0);
    expect(files.made).toEqual([]);
  });

  it("#2146 removes its directory when it throws", () => {
    files.failCopy = true;
    expect(() => createMigratedSqlite("2146-leak", { stopBefore: STOP })).toThrow(/ENOSPC/);
    expect(files.made).toHaveLength(1);
    expect(existsSync(files.made[0]!)).toBe(false);
  });

  it("names the exit status, the signal and the CLI's stdout when migrate deploy fails", () => {
    const sqlite = createMigratedSqlite("1364-killed", { stopBefore: STOP });
    cleanups.push(() => sqlite.cleanup());
    spawned.fail = Object.assign(new Error("Command failed: prisma migrate deploy"), {
      status: null,
      signal: "SIGKILL",
      stdout: Buffer.from('Datasource "db": SQLite database\n182 migrations found\n'),
      stderr: Buffer.from("Loaded Prisma config from prisma.config.ts.\n"),
    });
    let message = "";
    try {
      sqlite.apply(STOP);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("prisma migrate deploy failed");
    expect(message).toContain("signal SIGKILL");
    expect(message).toContain("status null");
    expect(message).toContain("182 migrations found");
    expect(message).toContain("Loaded Prisma config");
  });

  it("refuses an apply() whose deploy exited 0 without applying the migration", () => {
    const sqlite = createMigratedSqlite("1364-apply-noop", { stopBefore: STOP });
    cleanups.push(() => sqlite.cleanup());
    spawned.noop = true;
    expect(() => sqlite.apply(STOP)).toThrow(new RegExp(`missing: ${STOP}$`));
  });

  it("#2146 refuses an applyRemaining() whose deploy exited 0 without applying anything", () => {
    const sqlite = createMigratedSqlite("2146-remaining-noop", { stopBefore: STOP });
    cleanups.push(() => sqlite.cleanup());
    spawned.noop = true;
    expect(() => sqlite.applyRemaining()).toThrow(
      new RegExp(`${before(STOP).length} of ${ALL.length} migrations applied; missing: ${STOP}, `),
    );
  });
});

describe("#2146 — migratedSqliteTemplate", () => {
  it("names the missing globalSetup when nothing was provided", () => {
    expect(() => migratedSqliteTemplate(undefined)).toThrow(
      /does not list tests\/global-setup-migrated-sqlite\.ts in `globalSetup`/,
    );
  });

  it("does not take an inherited property for a template", () => {
    expect(() =>
      migratedSqliteTemplate({ head: "head.db", stopBefore: {} }, "constructor"),
    ).toThrow(/no migrated SQLite template stops before constructor/);
  });
});

describe("#2146 — the globalSetup templates", () => {
  it("hold, for every listed stopBefore, exactly the migrations before it", () => {
    const provided = inject(MIGRATED_SQLITE_TEMPLATES_KEY);
    expect(Object.keys(provided.stopBefore).sort()).toEqual([...STOP_BEFORE_MIGRATIONS].sort());
    for (const name of STOP_BEFORE_MIGRATIONS) {
      expect(applied(provided.stopBefore[name]!), name).toEqual(before(name));
    }
    expect(applied(provided.head)).toEqual(ALL);
  });

  it("list every stopBefore once, in migration order", () => {
    expect([...STOP_BEFORE_MIGRATIONS]).toEqual([...new Set(STOP_BEFORE_MIGRATIONS)].sort());
  });
});

describe("#2146 — buildMigratedSqliteTemplates", () => {
  it(
    "snapshots before each stop on one pass up the chain, and removes it all on cleanup",
    () => {
      const first = STOP_BEFORE_MIGRATIONS[0]!;
      const built = buildMigratedSqliteTemplates([LAST, first]);
      cleanups.push(() => built.cleanup());

      expect(spawned.calls).toBe(3);
      expect(applied(built.stopBefore[first]!)).toEqual(before(first));
      expect(applied(built.stopBefore[LAST]!)).toEqual(before(LAST));
      expect(applied(built.head)).toEqual(ALL);
      expect(tables(built.head)).toContain("users");

      built.cleanup();
      expect(existsSync(path.dirname(built.head))).toBe(false);
    },
    MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
  );

  it("refuses a stopBefore that names no migration, before spawning anything", () => {
    expect(() => buildMigratedSqliteTemplates(["20990101000000_no_such_migration"])).toThrow(
      /stopBefore names no migration in .*: 20990101000000_no_such_migration/,
    );
    expect(spawned.calls).toBe(0);
  });

  it("refuses a snapshot a deploy reported built but never wrote, and removes its directory", () => {
    spawned.noop = true;
    expect(() => buildMigratedSqliteTemplates([LAST])).toThrow(
      new RegExp(`is incomplete: 0 of ${ALL.length - 1} migrations applied`),
    );
    expect(spawned.calls).toBe(1);
    expect(files.made).toHaveLength(1);
    expect(existsSync(files.made[0]!)).toBe(false);
  });
});

describe("#1364 — assertMigrationsApplied", () => {
  const template = () => inject(MIGRATED_SQLITE_TEMPLATES_KEY).head;

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
  it("provides the built templates without their cleanup, and runs it on teardown", async () => {
    const cleanup = vi.fn();
    const built = { head: "/t/head.db", stopBefore: { [STOP]: `/t/before-${STOP}.db` } };
    vi.resetModules();
    vi.doMock("./sqlite-migrated-db.js", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      buildMigratedSqliteTemplates: () => ({ ...built, cleanup }),
    }));
    try {
      const { default: globalSetup } = await import("../global-setup-migrated-sqlite.js");
      const provide = vi.fn();
      const teardown = globalSetup({ provide } as never);
      // `provide` must be serializable: the cleanup function stays behind.
      expect(provide).toHaveBeenCalledWith(MIGRATED_SQLITE_TEMPLATES_KEY, built);
      expect(cleanup).not.toHaveBeenCalled();
      teardown();
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("./sqlite-migrated-db.js");
    }
  });
});
