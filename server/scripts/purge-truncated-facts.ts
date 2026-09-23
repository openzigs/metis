/**
 * #156 — delete Phase-1 fact-cache rows that were cut off by the output-token
 * cap, so the next generation re-extracts those modules instead of reusing
 * incomplete facts. Only rows from an older Phase-1 prompt version are swept
 * unless `--include-current` is given (see fact-cache-maintenance.ts).
 *
 *   pnpm --filter @metis/server facts:purge-truncated -- --dry-run
 *   pnpm --filter @metis/server facts:purge-truncated -- --project <projectId>
 *   pnpm --filter @metis/server facts:purge-truncated -- --min-output-tokens 16384
 *   pnpm --filter @metis/server facts:purge-truncated -- --include-current
 */
import { prisma } from "../src/lib/prisma.js";
import {
  parsePurgeArgs,
  purgeTruncatedFactCache,
  type FactCachePurgePrisma,
} from "../src/lib/docs-gen/fact-cache-maintenance.js";
import { PHASE1_PROMPT_VERSION } from "../src/lib/docs-gen/holistic-synthesizer.js";

async function main(): Promise<void> {
  // pnpm forwards a literal `--` separator; it is not an argument.
  const args = parsePurgeArgs(process.argv.slice(2).filter((a) => a !== "--"));

  const report = await purgeTruncatedFactCache(prisma as unknown as FactCachePurgePrisma, {
    ...args,
    currentPromptVersion: PHASE1_PROMPT_VERSION,
  });

  const scope = report.includeCurrentVersion
    ? "any prompt version"
    : `prompt version < ${PHASE1_PROMPT_VERSION}`;
  process.stdout.write(
    `${report.dryRun ? "[dry-run] " : ""}${report.matched} fact-cache row(s) with outputTokens >= ` +
      `${report.minOutputTokens} (${scope})` +
      `${report.dryRun ? " would be deleted" : ` deleted (${report.deleted})`}\n`,
  );
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`purge failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
