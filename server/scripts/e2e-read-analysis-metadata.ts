/**
 * Read an Analysis row's `metadata` JSON directly from the e2e SQLite database
 * (epic #209 / #235).
 *
 * The #235 acceptance criteria require asserting the refined requirement is
 * *persisted* — not merely echoed in an HTTP response. This script bypasses the
 * API surface entirely and reads the durable `Analysis.metadata` blob via
 * Prisma, so the spec can prove the clarification route's
 * `persistAnalysisEnhancement(...structuredRequirements)` write landed in the DB.
 *
 * Usage:
 *   tsx server/scripts/e2e-read-analysis-metadata.ts <analysisId>
 * Output: the raw `metadata` JSON string on stdout (or `null`).
 */
/* eslint-disable no-console -- CLI script: emits the metadata blob to stdout */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

async function main(): Promise<void> {
  const [analysisId] = process.argv.slice(2);
  if (!analysisId) {
    console.error("usage: e2e-read-analysis-metadata.ts <analysisId>");
    process.exit(2);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set");
    process.exit(2);
  }

  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  try {
    const row = await prisma.analysis.findFirst({
      where: { id: analysisId },
      select: { metadata: true },
    });
    process.stdout.write(row?.metadata ?? "null");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
