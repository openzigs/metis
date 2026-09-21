/**
 * Epic #70 / sub-issue #76 — `pnpm dr:check`.
 *
 *   pnpm dr:check
 *
 * Measures Postgres streaming-replication lag on the standby and exits non-zero
 * when the standby is missing, lagging beyond DR_MAX_REPLICATION_LAG_SECONDS
 * (default 600s / 10 min), or unreachable — so it can gate a quarterly drill or
 * page on-call. Because Postgres also hosts the pgvector store (#543), this one
 * WAL-lag measurement covers both application data and RAG vectors.
 *
 * This file is a thin CLI wrapper (coverage-excluded — vitest's `include` is
 * `src/**`). All decision logic lives in and is unit-tested from
 * `src/lib/dr/replication-check.ts`.
 */
import { prisma } from "../src/lib/prisma.js";
import {
  checkReplication,
  createPrismaReplicationQuerier,
  resolveThresholdSeconds,
} from "../src/lib/dr/replication-check.js";

async function main(): Promise<void> {
  const threshold = resolveThresholdSeconds();
  const querier = createPrismaReplicationQuerier(prisma);
  const result = await checkReplication(querier, threshold);

  const line =
    `DR-CHECK status=${result.status} lag=${result.lagSeconds ?? "n/a"}s ` +
    `threshold=${result.thresholdSeconds}s receive_lsn=${result.receiveLsn ?? "n/a"} ` +
    `replay_lsn=${result.replayLsn ?? "n/a"}`;

  if (result.ok) {
    // eslint-disable-next-line no-console
    console.log(`${line}\n${result.message}`);
  } else {
    // eslint-disable-next-line no-console
    console.error(`${line}\nFAIL — ${result.message}`);
  }

  await prisma.$disconnect().catch(() => {});
  process.exit(result.ok ? 0 : 1);
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error("dr:check runner failed:", err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
