---
name: prisma-sqlite-interactive-transactions
description: Interactive prisma.$transaction on the better-sqlite3 adapter — one writer at a time, 2 s maxWait (P2028), plain queries joining an open transaction, the long withVectorSql holder, and what moving a write into a transaction does to tests (#1510).
metadata:
  type: project
---

From #1510 and its review cycles (2026-10-24), which moved vault value writes into an
interactive `prisma.$transaction`.

- **One lock, 2 s wait.** With `@prisma/adapter-better-sqlite3`, interactive transactions
  serialise behind one lock (default `maxWait` 2 s), while plain queries join any open
  transaction on the shared connection. Moving a write into `$transaction` swaps "silently
  joins another transaction" for "P2028 after 2 s" (#1499 surfaces it as 503
  `DATABASE_BUSY`). The long holder is `withVectorSql` (`server/src/lib/rag/project-vector-write.ts`,
  up to 10 min including embedder calls).
- **A test that triggers a vault write from inside another vault write's transaction waits
  on itself** (one write transaction at a time). Inject the competing write outside the
  transaction.
- **Spies stop seeing the write.** Once the write runs inside an interactive transaction,
  spies on `db.secret.updateMany/update/upsert` see nothing; route spies through
  `$transaction` (see `spyOnSwap` in `server/tests/vault-rotation-undo-593.sqlite.test.ts`).

Related: [[prisma-cross-database]], [[repo-connector-proof-and-vault-writes]].

## Postgres differs: a write conflict is not P2034 (2026-11-07)

On Postgres through `@prisma/adapter-pg`, a `Serializable` transaction's write conflict (SQLSTATE `40001`, and deadlock `40P01`) surfaces as a `DriverAdapterError` whose `cause.kind` is `TransactionWriteConflict` — it carries **no** Prisma `P2034` code. A retry loop that checks only `code === "P2034"` retries on SQLite and gives up on the first conflict on Postgres (found on #1893's borrow race). Measured on #1904: a refused STATEMENT inside an interactive transaction (two claims of one row) DOES arrive as `P2034`; a refused COMMIT (`could not serialize access due to read/write dependencies`, e.g. claims of two different rows that each read the table the other wrote) arrives as the raw `DriverAdapterError`. Use `isSerializationFailure` in `server/src/lib/db/prisma-errors.ts` (#1904); to force the commit-time shape, hold every racer at a barrier after its writes, before commit.

**Why:** the SQLite driver path maps the conflict to P2034; the pg adapter does not, so a SQLite-only race test passes while production Postgres fails.

**How to apply:** match both shapes in any write-conflict retry, and prove the retry with a Postgres twin of the race test (`postgres-unit`), not SQLite alone. After the last attempt, answer a named 409, not an unnamed 500.
