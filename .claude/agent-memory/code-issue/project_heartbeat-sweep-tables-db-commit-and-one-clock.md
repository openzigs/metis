---
name: heartbeat-sweep-tables-db-commit-and-one-clock
description: Rules for any heartbeat-and-sweep job table (spec_kit_jobs, generated_documents, anything modelled on them) once there is more than one replica. Found by review on #1059 (PR #1105), where both were missing and both reproduced on real SQLite.
metadata:
  type: project
---

For heartbeat-and-sweep job tables, the write path must re-check row ownership in the DATABASE at commit — an in-memory stop flag does not cover another replica's sweep — and staleness must be judged with one clock, not `new Date()` on the reader.

**Why:** #1059 first shipped a commit point that consulted only the job's in-memory state, and a stale check that compared the reader's `new Date()` with a heartbeat the owner's clock wrote. A row failed by another replica (or by this one, while the job was already saving) released the lock, a second job started on the same feature, and the first job still wrote: two interleaved five-artifact sets. A reader 100 s ahead failed a live job on any member's GET.

**How to apply:**

- **Probe:** park the stub model call, apply `finishJob`'s update by hand, start a second job on the same key, then answer the first call. If the first job writes, the commit point is not in the database.
- **Commit as a row transition.** `running -> saving` in one conditional UPDATE on (id, status, activeKey). Cancel (`running -> cancelling`) and the time limit (`running -> failed`) condition on the same status, so each race has one winner without shared memory. Re-check before every later write. The in-process registry may only abort a model call sooner; never ask it whether to write.
- **One clock means the database's, in the same statement.** Write `heartbeatAt` with DB now and compare with DB now inside the sweep's UPDATE. That needs raw SQL per engine: Postgres `timezone('UTC', clock_timestamp())` against `TIMESTAMP(3)`; SQLite `strftime('%Y-%m-%dT%H:%M:%f+00:00','now')`, which is exactly the text Prisma's better-sqlite3 adapter stores for a `DateTime` (so it sorts as text). A raw INSERT's unique refusal is `P2010` with `meta.driverAdapterError.cause.kind === "UniqueConstraintViolation"`, not `P2002`.
- **Test both clocks.** `vi.useFakeTimers({ toFake: ["Date"] })` moves this process's clock and leaves the database's alone: reader ahead must not fail a live job; owner behind must not have its beats read as stale. An in-memory fake must capture `Date.now` at load or the test is vacuous on it.
- **A finished row keeps its last heartbeat.** The sweep's status filter is what stops it rewriting a succeeded job as failed; plant terminal rows with OLD heartbeats, or deleting the filter stays green.
- **Run the store's contract on the real store.** One assertion set over the fake, real SQLite and real Postgres (`tests/helpers/spec-kit-job-store-contract.ts`); a race suite that only runs on a fake re-implementation tests the fake. See [[project_sqlite-tests-skip-on-postgres-adapter]].
- **Say what is true when the outcome is unknown.** "Nothing was saved" is only a fact for a row that never reached `saving`.

docs-gen (`interrupted-generations.ts`) has the reader-clock shape (5-minute threshold, sweep only) but its publish IS a database compare-and-set on the claim, so it cannot double-write.
