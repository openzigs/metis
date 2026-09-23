/**
 * #156 — delete Phase-1 fact-cache rows that were cut off by the output-token
 * cap, so the next generation re-extracts those modules instead of reusing
 * incomplete facts.
 *
 *   pnpm --filter @metis/server facts:purge-truncated -- --dry-run
 *   pnpm --filter @metis/server facts:purge-truncated -- --project <projectId>
 *   pnpm --filter @metis/server facts:purge-truncated -- --min-output-tokens 16384
 */
import { prisma } from "../src/lib/prisma.js";
import {
  purgeTruncatedFactCache,
  type FactCachePurgePrisma,
} from "../src/lib/docs-gen/fact-cache-maintenance.js";

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const projectId = flagValue("project");
  const minRaw = flagValue("min-output-tokens");
  const minOutputTokens = minRaw === undefined ? undefined : Number(minRaw);

  const report = await purgeTruncatedFactCache(prisma as unknown as FactCachePurgePrisma, {
    dryRun,
    ...(projectId ? { projectId } : {}),
    ...(minOutputTokens !== undefined ? { minOutputTokens } : {}),
  });

  process.stdout.write(
    `${dryRun ? "[dry-run] " : ""}${report.matched} fact-cache row(s) with outputTokens >= ` +
      `${report.minOutputTokens}${dryRun ? " would be deleted" : ` deleted (${report.deleted})`}\n`,
  );
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`purge failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
