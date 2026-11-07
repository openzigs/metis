/**
 * #1949 — a hand-built SQLite fixture with no disk under it.
 *
 * A file-backed SQLite database fsyncs every autocommit statement: a `beforeAll`
 * that creates 13 tables and inserts one row issues 56 `fsync` calls (counted with
 * `strace -c` on Linux). On a `server-unit` runner whose disk is shared with
 * neighbouring suites replaying migration chains, one fsync can stall for hundreds
 * of milliseconds, and at 300 ms each that hook took 17.4 s against the 10 s
 * `hookTimeout` (injected with `strace -e inject=fsync:delay_enter=300000`). The
 * same work against `:memory:` issues no fsync and took 12 ms under the same
 * injection. A suite that builds its own tables, and never reopens the database
 * from a second connection, has no reason to touch the disk at all.
 *
 * The `@prisma/adapter-better-sqlite3` factory opens ONE `better-sqlite3`
 * connection per client, so every query of that client sees the same in-memory
 * database for the client's lifetime. A second client (or a `$disconnect` and
 * reconnect) would see an empty one — use a file for a suite that needs that.
 */
import type { PrismaClient } from "@prisma/client";

/** The `better-sqlite3` path for a private, in-memory database. */
export const IN_MEMORY_SQLITE = ":memory:";

/**
 * The file backing the client's `main` database: `""` for an in-memory one. A
 * suite asserts this so a later edit that points it back at a file goes red.
 */
export async function sqliteMainFile(db: PrismaClient): Promise<string | undefined> {
  const rows = await db.$queryRaw<{ file: string }[]>`
    SELECT file FROM pragma_database_list WHERE name = 'main'`;
  return rows[0]?.file;
}
