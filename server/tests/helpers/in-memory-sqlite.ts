/**
 * #1949 — a hand-built SQLite fixture with no disk under it.
 *
 * A file-backed SQLite database fsyncs every autocommit statement, four times per
 * statement (counted with `strace -c` on Linux, #1960): the embedding suite's
 * `beforeAll`, 12 `CREATE TABLE`s and one `INSERT`, issues 52 `fsync` calls, and the
 * ownership suite's, 11 and one, 48. On a `server-unit` runner whose disk is shared
 * with neighbouring suites replaying migration chains, one fsync can stall for
 * hundreds of milliseconds: at 300 ms each, 14 statements (56 fsyncs) took 17.4 s
 * against the 10 s `hookTimeout` (injected with
 * `strace -e inject=fsync:delay_enter=300000`). The same work against `:memory:`
 * issues no fsync and took 12 ms under the same injection. A suite that builds its
 * own tables, and never reopens the database from a second connection, has no
 * reason to touch the disk at all.
 *
 * The `@prisma/adapter-better-sqlite3` factory opens ONE `better-sqlite3`
 * connection per client, so every query of that client sees the same in-memory
 * database for the client's lifetime. A second client (or a `$disconnect` and
 * reconnect) would see an empty one — use a file for a suite that needs that,
 * and {@link skipSqliteFsync} on it.
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

/**
 * #1960 — for a suite that must keep a file because a second connection or a
 * child process opens it: stop THIS client's fsyncs. With `synchronous = OFF`
 * SQLite hands each commit to the OS and moves on, so a 15-table hook went from
 * 64 `fsync` calls to none, and from 20 s to 20 ms under the 300 ms injection
 * above. Commits stay visible to other connections at once (they read the OS
 * cache); only crash durability, which a throwaway test file does not need, goes.
 * The setting is per connection, so call it once, right after creating the client.
 */
export async function skipSqliteFsync(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe("PRAGMA synchronous = OFF");
}

/** The client's `PRAGMA synchronous` level: `0` once {@link skipSqliteFsync} ran. */
export async function sqliteSynchronous(db: PrismaClient): Promise<number | undefined> {
  const rows = await db.$queryRaw<{ synchronous: number | bigint }[]>`
    SELECT synchronous FROM pragma_synchronous`;
  return rows[0] === undefined ? undefined : Number(rows[0].synchronous);
}
