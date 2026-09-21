/**
 * Issue #798 — a child process that takes a project's reindex lease and then parks
 * forever, so the integration test can SIGKILL it (the pod-eviction / OOM-kill shape)
 * and prove the abandoned lease does not wedge the next attempt.
 *
 * It must be a REAL separate process: the whole failure mode is about state that
 * outlives the holder's death, and an in-process `Promise` that we simply stop
 * awaiting would prove nothing (it would still be renewing).
 *
 * Prints `ACQUIRED <holder>` on stdout once it holds the lease. Never exits on its own.
 */
import { PostgresReindexLeaseBackend, reindexLockName } from "../../src/lib/rag/reindex-lease.js";
import { makeSchemaScopedPrismaClient } from "../lib/pg/pg-test-schema.js";

async function main(): Promise<void> {
  const projectId = process.env.REINDEX_LEASE_PROJECT_ID;
  const holder = process.env.REINDEX_LEASE_HOLDER ?? "child:run";
  const ttlMs = Number.parseInt(process.env.REINDEX_LEASE_TTL_MS ?? "3000", 10);
  if (!projectId) throw new Error("REINDEX_LEASE_PROJECT_ID is required");

  // #806 — this is a SEPARATE process (a real pod) with its OWN pool. It MUST pin the same
  // private schema the parent suite uses (via `REINDEX_LEASE_SCHEMA`) at connect time, or it
  // would acquire the lease against `public` and the parent — pinned to the private schema —
  // would never see it. Defaults to `public` when run without a schema.
  const schema = process.env.REINDEX_LEASE_SCHEMA ?? "public";
  const prisma = makeSchemaScopedPrismaClient(schema, process.env.DATABASE_URL ?? "");
  const backend = new PostgresReindexLeaseBackend(prisma);

  const row = await backend.acquire(reindexLockName(projectId), holder, Date.now(), ttlMs);
  if (!row) throw new Error(`could not acquire the reindex lease for ${projectId}`);

  process.stdout.write(`ACQUIRED ${holder}\n`);

  // Park. Deliberately NO renew loop and NO signal handler: a SIGKILLed pod does not
  // get to run cleanup, and that is exactly the state under test.
  await new Promise(() => {});
}

main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
