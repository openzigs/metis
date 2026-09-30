/**
 * #547 — read-only report of uploads stored before #540 under a reserved
 * (connector- or generated-shaped) filename. Changes nothing.
 *
 *   pnpm --filter @metis/server documents:reserved-uploads
 *   pnpm --filter @metis/server documents:reserved-uploads -- --json
 */
import { prisma } from "../src/lib/prisma.js";
import {
  findReservedPrefixUploads,
  formatReservedPrefixUploads,
  type ReservedPrefixUploadsPrisma,
} from "../src/lib/documents/reserved-prefix-uploads.js";

async function main(): Promise<void> {
  const client: ReservedPrefixUploadsPrisma = prisma;
  const rows = await findReservedPrefixUploads(client);
  const json = process.argv.slice(2).includes("--json");
  process.stdout.write(
    `${json ? JSON.stringify(rows, null, 2) : formatReservedPrefixUploads(rows)}\n`,
  );
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`report failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
