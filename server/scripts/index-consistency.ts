#!/usr/bin/env tsx
/**
 * #2346 — check, and repair, a project's symbol index.
 *
 *   pnpm index:consistency --project <id>            # read-only report
 *   pnpm index:consistency --all                     # every project
 *   pnpm index:consistency --project <id> --repair   # re-queue missing vectors, remove orphans
 *
 * The thin entry point: argv, stdout, exit codes. What is checked and how a
 * repair is ordered and leased lives in `src/lib/code-graph/index-consistency.ts`,
 * which is unit-tested; this wrapper is outside coverage, as `embed-migrate.ts` is.
 *
 * A repair is refused when the database records a running source ingest of
 * one of the project's repositories (`sourceIngestState`, which the API
 * server writes and heartbeats), and, on Postgres, while a symbol embed or a
 * reindex holds the project's reindex lease (a database row every replica
 * honours; on SQLite that lease is per process). The connector ingest lease it
 * also takes is per process (`ingest-guard.ts`) and excludes nothing the API
 * server runs. A sync's code-graph step records nothing, so run --repair when
 * no sync of the project is in progress; what an overlap can do is bounded
 * (see the module header of `index-consistency.ts`).
 *
 * EXIT CODES: 0 consistent (after the repair, with --repair); 1 inconsistent;
 * 2 usage error, or a repair refused because an ingest or reindex is running.
 */
import { prisma } from "../src/lib/prisma.js";
import {
  checkIndexConsistency,
  isConsistent,
  repairIndexConsistency,
  summarizeConsistency,
  type IndexConsistencySummary,
} from "../src/lib/code-graph/index-consistency.js";
import { ReindexConflictError } from "../src/lib/rag/reindex-lease.js";
import { vectorStoreKind } from "../src/lib/rag/embed-migration.js";
import { registerPgVectorStore } from "../src/lib/rag/vector-store-pgvector.js";

const USAGE = `
metis index:consistency — check a project's symbol index, and repair it

  --project <id>     The project to check.
  --all              Every project.
  --repair           Re-queue the embeddings of symbols tagged as embedded with
                     no vector, run the embed job, and remove vectors with no
                     symbol. Commit drift is reported only: re-sync the repository.

EXIT CODES: 0 consistent; 1 inconsistent; 2 usage error, or a repair refused.
`.trim();

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function formatSummary(s: IndexConsistencySummary): string {
  return [
    `  vectors with no symbol row:          ${s.orphanVectors}`,
    `  symbols tagged embedded, no vector:  ${s.missingVectors}`,
    `  symbols not embedded yet:            ${s.pendingEmbeddings}`,
    `  symbols at another commit:           ${s.driftedSymbols} (in ${s.driftedGraphs} graph(s))`,
  ].join("\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return argv.length === 0 ? 2 : 0;
  }
  if (vectorStoreKind() === "pgvector") registerPgVectorStore();

  const repair = argv.includes("--repair");
  const projectId = option(argv, "project");
  const all = argv.includes("--all");
  if (!projectId === !all) {
    process.stderr.write("Give exactly one of --project <id> or --all.\n");
    return 2;
  }
  const projects = all
    ? (await prisma.project.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map(
        (p) => p.id,
      )
    : [projectId as string];

  let code = 0;
  for (const id of projects) {
    if (!repair) {
      const s = summarizeConsistency(await checkIndexConsistency(id));
      const ok = isConsistent(s);
      process.stdout.write(
        `Project ${id}: ${ok ? "consistent" : "INCONSISTENT"}\n${formatSummary(s)}\n`,
      );
      if (!ok) code = Math.max(code, 1);
      continue;
    }
    try {
      const r = await repairIndexConsistency(id);
      if (r.status === "ingest-in-progress") {
        process.stdout.write(
          `Project ${id}: refused, an ingest is running for connector(s) ${r.connectorIds.join(", ")}\n`,
        );
        code = 2;
        continue;
      }
      const ok = isConsistent(r.after);
      process.stdout.write(
        `Project ${id}: ${ok ? "consistent" : "STILL INCONSISTENT"} after repair ` +
          `(re-queued ${r.requeued}, removed ${r.removedOrphans} orphan vector(s), ` +
          `embedded ${r.embed?.embedded ?? 0}, reused ${r.embed?.reused ?? 0})\n` +
          `before:\n${formatSummary(r.before)}\nafter:\n${formatSummary(r.after)}\n`,
      );
      if (!ok) code = Math.max(code, 1);
    } catch (err) {
      if (err instanceof ReindexConflictError) {
        process.stdout.write(`Project ${id}: refused, a symbol embed or reindex holds its lease\n`);
        code = 2;
        continue;
      }
      throw err;
    }
  }
  return code;
}

main()
  .then((code) => {
    // `process.exitCode`, not `process.exit()`: a repair may have loaded the
    // embedder, whose native session must close first (#808, embed-migrate.ts).
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`\n${(err as Error).message}\n`);
    process.exitCode = 1;
  });
