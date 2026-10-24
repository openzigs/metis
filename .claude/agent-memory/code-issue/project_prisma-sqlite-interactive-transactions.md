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
