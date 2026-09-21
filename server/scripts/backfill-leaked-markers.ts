/**
 * #1370 — strip leaked `[facts:…]` / `[rag:…]` grounding markers from stored
 * generated documents and the knowledge chunks cut from them.
 *
 * The generation-time stripper is forward-only; this cleans what is already in
 * the database. Idempotent and re-runnable — a second run reports zero updates.
 *
 *   pnpm --filter @metis/server backfill:leaked-markers -- --dry-run
 *   pnpm --filter @metis/server backfill:leaked-markers -- --project <projectId>
 */
import { prisma } from "../src/lib/prisma.js";
import {
  backfillLeakedMarkers,
  type LeakedMarkerBackfillPrisma,
} from "../src/lib/docs-gen/leaked-marker-backfill.js";

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const projectId = flagValue("project");

  const report = await backfillLeakedMarkers(prisma as unknown as LeakedMarkerBackfillPrisma, {
    dryRun,
    ...(projectId ? { projectId } : {}),
  });

  process.stdout.write(
    `${dryRun ? "[dry-run] " : ""}documents ${report.documentsUpdated}/${report.documentsScanned} updated, ` +
      `chunks ${report.chunksUpdated}/${report.chunksScanned} updated, ` +
      `${report.markersRemoved} markers removed\n`,
  );
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`backfill failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
