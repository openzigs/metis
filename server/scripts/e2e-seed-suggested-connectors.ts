/**
 * Seed script for suggested connectors — used by e2e tests.
 *
 * Usage:
 *   pnpm --filter @metis/server exec tsx scripts/e2e-seed-suggested-connectors.ts \
 *     <projectId> <json-array-of-suggestions>
 *
 * Outputs: JSON array of created IDs, one per line.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface SeedInput {
  driverType: string;
  host: string | null;
  port: number | null;
  database: string | null;
  sourceFile: string;
  lineNumber: number;
  confidence: string;
}

async function main(): Promise<void> {
  const [projectId, suggestionsJson] = process.argv.slice(2);
  if (!projectId || !suggestionsJson) {
    // eslint-disable-next-line no-console
    console.error("Usage: tsx e2e-seed-suggested-connectors.ts <projectId> <json>");
    process.exit(1);
  }

  const suggestions: SeedInput[] = JSON.parse(suggestionsJson);
  const ids: string[] = [];

  for (const s of suggestions) {
    const record = await prisma.suggestedConnector.create({
      data: {
        projectId,
        driverType: s.driverType,
        host: s.host,
        port: s.port,
        database: s.database,
        sourceFile: s.sourceFile,
        lineNumber: s.lineNumber,
        confidence: s.confidence,
        status: "pending",
      },
    });
    ids.push(record.id);
  }

  // Output as JSON array so the caller can parse it
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(ids));
  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
