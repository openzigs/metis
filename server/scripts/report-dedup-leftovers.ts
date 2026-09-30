/**
 * #396 — read-only report of what the #369 issue-draft dedup migration left
 * behind: retired drafts that still have a published issue, and live drafts
 * whose parent was retired. Changes nothing; run it against a database that
 * applied #369 before deciding whether to close a separate issue (one the
 * kept draft shares is not a duplicate).
 *
 *   pnpm --filter @metis/server publishing:dedup-leftovers
 *   pnpm --filter @metis/server publishing:dedup-leftovers -- --json
 */
import { prisma } from "../src/lib/prisma.js";
import {
  findDedupLeftovers,
  formatDedupLeftovers,
  type DedupLeftoversPrisma,
} from "../src/lib/publishing/dedup-leftovers.js";

async function main(): Promise<void> {
  const client: DedupLeftoversPrisma = prisma;
  const report = await findDedupLeftovers(client);
  const json = process.argv.slice(2).includes("--json");
  process.stdout.write(
    `${json ? JSON.stringify(report, null, 2) : formatDedupLeftovers(report)}\n`,
  );
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`report failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
