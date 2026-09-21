#!/usr/bin/env tsx
/**
 * Issue #787 — the embedding-model migration CLI.
 *
 *   pnpm embeddings:migrate status
 *   pnpm embeddings:migrate prepare --force
 *   pnpm embeddings:migrate reindex --all [--batch-size 128] [--fresh]
 *   pnpm embeddings:migrate reindex --project <id>
 *   pnpm embeddings:migrate retag --force
 *   pnpm embeddings:migrate discard --project <id>
 *   pnpm embeddings:migrate lock-status --project <id>
 *   pnpm embeddings:migrate unlock --project <id> [--force]
 *
 * This file is the THIN entry point — argv parsing, stdout, exit codes. Every
 * decision it makes lives in `src/lib/rag/embed-migration.ts` and
 * `src/lib/rag/knowledge-service.ts`, which are unit-tested; this wrapper is
 * excluded from coverage the same way `dr-check.ts` and the SSO provider adapters
 * are.
 *
 * The runbook that drives it is docs/EMBEDDINGS_BACKENDS.md § "Migrating to a new
 * embedding model".
 */
import {
  defaultMigrationDeps,
  formatLockStatus,
  formatStatus,
  migrationStatus,
  planMigration,
  prepareRefusal,
  reindexAll,
  retagRefusal,
  unlockRefusal,
  vectorStoreKind,
} from "../src/lib/rag/embed-migration.js";
import { getKnowledgeService } from "../src/lib/rag/knowledge-service.js";
import { getVectorStore } from "../src/lib/rag/vector-store.js";
import { registerPgVectorStore } from "../src/lib/rag/vector-store-pgvector.js";

/** A store that can migrate its own column width (pgvector). */
interface ColumnMigratableStore {
  migrateColumnDimension(): Promise<{
    from: number | null;
    to: number;
    migrated: boolean;
    droppedRows: number;
  }>;
}

function isColumnMigratable(store: unknown): store is ColumnMigratableStore {
  return typeof (store as ColumnMigratableStore).migrateColumnDimension === "function";
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const USAGE = `
metis embeddings:migrate — migrate a deployment onto a new embedding model

  status                          Show the embedder, the store's vector width, the
                                  per-model chunk coverage of every project, and the
                                  per-CHUNKER-generation split (#1182).
  prepare --force                 pgvector ONLY: migrate the shared vector column to
                                  the active embedder's width. DESTRUCTIVE to the old
                                  vectors (never to the chunk text they came from).
                                  Refuses outright while the embedder is unhealthy or
                                  has fallen back to the hash stub.
  reindex --all                   Reindex every project whose chunks are on another
                                  model. Resumable: re-run it after an interruption
                                  and it picks up from the shadow it left behind.
  reindex --project <id>          Reindex one project.
  retag --force                   Re-label every chunk as the ACTIVE model WITHOUT
                                  re-embedding. ONLY after restoring a pg_dump of
                                  rag_vectors taken while that model was active.
  discard --project <id>          Throw away a project's resume checkpoint. Refuses
                                  (409) while a reindex holds the lease — including
                                  one running on another replica.
  lock-status --project <id>      Show who holds the project's reindex lease, when they
                                  last renewed it, and whether it has EXPIRED (#798).
  unlock --project <id>           Clear a wedged reindex lease WITHOUT restarting the
                                  pod. Refuses a LIVE lease unless --force; a cleared
                                  holder is FENCED, so the worst case is a re-run (#798).

Options:
  --batch-size <n>                Chunks per embed call (default 128).
  --fresh                         Ignore any resume checkpoint; rebuild from scratch.
  --force                         Required by \`prepare\` (it drops vectors), by
                                  \`retag\` (it rewrites every chunk's model tag), and
                                  by \`unlock\` when the lease is still LIVE.

EXIT CODES (\`status\`) — they encode WHETHER THE INDEX IS SERVING, not severity order:

  0   Nothing outstanding.
  1   MODEL or column drift, or a broken embedder. Those rows are DARK: the read
      path filters on the model tag, so dense retrieval returns nothing for them.
      Remedy: \`prepare\` / \`reindex\`. Unchanged from before #1182.
  2   Usage error, or a command refused a destructive action.
  3   CHUNKER drift ONLY (#1182). The index is SERVING — the vectors are in the
      same space and still rank — but chunks cut before #1178 have gaps, so
      retrieval is degraded rather than absent. Remedy: RE-INGEST the documents;
      \`reindex\` re-embeds stored chunk text and will not move a boundary.

  A deploy gate that must block only on a dark index should treat 3 as a warning:
      pnpm embeddings:migrate status; c=$?; [ "$c" -eq 0 ] || [ "$c" -eq 3 ]
  Before #1182 chunker drift exited 0 and printed "Up to date.", so a gate that
  treats every non-zero code as fatal will newly fail on a corpus that was already
  degraded — that visibility is the point of the issue, not a regression.

Rollback: point EMBED_MODEL (and EMBED_DTYPE / EMBED_POOLING_MAP, if you moved them)
back at the previous model, then either

  - restore the pg_dump you took before \`prepare\`, and \`retag --force\` (no re-embed); or
  - re-run \`prepare --force\` if the width differs, then \`reindex --all\` (one re-embed).

Chunk text is the source of truth, so the old index is never more than one reindex
away either way. See docs/EMBEDDINGS_BACKENDS.md.
`.trim();

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || flag(argv, "help") || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  // The pgvector store is registered through a factory seam so `vector-store.ts`
  // never statically imports Prisma. `server.ts` does this at startup; a CLI has
  // to do it itself or `getVectorStore()` fails loud on VECTOR_STORE=pgvector.
  if (vectorStoreKind() === "pgvector") registerPgVectorStore();

  const batchSizeRaw = option(argv, "batch-size");
  const batchSize = batchSizeRaw ? Number.parseInt(batchSizeRaw, 10) : undefined;
  if (batchSizeRaw && (!Number.isInteger(batchSize) || (batchSize as number) < 1)) {
    process.stderr.write(`Invalid --batch-size "${batchSizeRaw}".\n`);
    return 2;
  }
  const fresh = flag(argv, "fresh");
  const projectId = option(argv, "project");

  switch (command) {
    case "status": {
      const status = await migrationStatus(defaultMigrationDeps());
      const plan = planMigration(status);
      process.stdout.write(`${formatStatus(status, plan)}\n`);
      // Exit codes — see the EXIT CODES block in USAGE. 1 stays exactly what it
      // was so existing deploy gates are unchanged; 3 is the new, distinct signal
      // for chunker drift, which is degraded-but-serving rather than dark (#1182).
      if (!plan.upToDate) return 1;
      if (plan.projectsToReingest.length > 0) return 3;
      return 0;
    }

    case "prepare": {
      const status = await migrationStatus(defaultMigrationDeps());
      // PR #796 review (B1) — the HEALTH gate comes before everything, including
      // the "nothing to do" fast path: with a hash fallback active, the width this
      // command would migrate TO is the stub's, and `needsColumnMigration` is a
      // diagnostic, not a decision. `--force` gates intent, not fitness.
      const refusal = prepareRefusal(status, { force: flag(argv, "force") });
      if (refusal && planMigration(status).blocked) {
        process.stderr.write(`${refusal}\n`);
        return 2;
      }
      if (!status.store.needsColumnMigration) {
        process.stdout.write(
          `Nothing to prepare: the store's vector width already matches the active ` +
            `embedder (${status.embedder.dimension}d).\n`,
        );
        return 0;
      }
      const store = getVectorStore();
      if (!isColumnMigratable(store)) {
        process.stderr.write(
          `The "${status.store.kind}" store has no deployment-wide column to migrate. ` +
            `Run \`reindex --all\` instead.\n`,
        );
        return 2;
      }
      if (refusal) {
        process.stderr.write(`${refusal}\n`);
        return 2;
      }
      const result = await store.migrateColumnDimension();
      process.stdout.write(
        `Migrated the shared vector column: ${String(result.from)}d -> ${result.to}d ` +
          `(${result.droppedRows} old vectors dropped).\n` +
          `Every project must now be reindexed: pnpm embeddings:migrate reindex --all\n`,
      );
      return 0;
    }

    case "reindex": {
      const status = await migrationStatus(defaultMigrationDeps());
      const plan = planMigration(status);
      if (plan.blocked) {
        process.stderr.write(`REFUSING to reindex. ${plan.blocked}\n`);
        return 2;
      }
      if (plan.needsColumnMigration) {
        process.stderr.write(
          `REFUSING to reindex: the shared pgvector column is ` +
            `${String(status.store.storedDimension)}d but the embedder emits ` +
            `${status.embedder.dimension}d. Every insert would be rejected mid-run.\n` +
            `Run \`pnpm embeddings:migrate prepare --force\` first.\n`,
        );
        return 2;
      }

      if (projectId) {
        const result = await getKnowledgeService().reindexProject(projectId, {
          ...(batchSize !== undefined ? { batchSize } : {}),
          fresh,
          onProgress: ({ processed, total }) =>
            process.stdout.write(`\r  ${projectId}: ${processed}/${total} chunks`),
        });
        process.stdout.write(
          `\r  ${projectId}: ${result.totalChunks}/${result.totalChunks} chunks — done ` +
            `(${result.embeddedChunks} embedded, ${result.resumedChunks} resumed, ` +
            `${Math.round(result.durationMs / 1000)}s)\n`,
        );
        return 0;
      }

      if (!flag(argv, "all")) {
        process.stderr.write("Pass --project <id> or --all.\n");
        return 2;
      }

      const { results, failures } = await reindexAll(defaultMigrationDeps(), {
        ...(batchSize !== undefined ? { batchSize } : {}),
        fresh,
        onProject: (id, i, total) => process.stdout.write(`\n[${i}/${total}] ${id}\n`),
        onProgress: (id, processed, total) =>
          process.stdout.write(`\r  ${id}: ${processed}/${total} chunks`),
      });

      process.stdout.write("\n\n");
      const embedded = results.reduce((n, r) => n + r.embeddedChunks, 0);
      const resumed = results.reduce((n, r) => n + r.resumedChunks, 0);
      process.stdout.write(
        `Reindexed ${results.length} project(s): ${embedded} chunks embedded, ` +
          `${resumed} resumed from interrupted runs.\n`,
      );
      if (failures.length > 0) {
        process.stderr.write(`\n${failures.length} project(s) FAILED:\n`);
        for (const f of failures) {
          process.stderr.write(
            `  ${f.projectId}: ${f.error}\n` +
              `    (its shadow was retained — re-run to resume where it stopped)\n`,
          );
        }
        return 1;
      }
      return 0;
    }

    case "retag": {
      // PR #796 review (S2) — the other half of the pg_dump rollback: re-label the
      // chunks to match vectors that have just been RESTORED, instead of re-embedding
      // them and overwriting what you restored.
      const status = await migrationStatus(defaultMigrationDeps());
      const refusal = retagRefusal(status, { force: flag(argv, "force") });
      if (refusal) {
        process.stderr.write(`${refusal}\n`);
        return 2;
      }
      const { model, retagged, skipped } = await getKnowledgeService().retagToActiveModel();
      process.stdout.write(
        `Retagged ${retagged} chunk(s) to "${model}" WITHOUT re-embedding.\n` +
          `This vouches for the vectors already in the store. If they were not produced by\n` +
          `"${model}", run \`reindex --all\` now — coverage will otherwise report an index\n` +
          `that is not there.\n`,
      );
      // Issue #804 — chunks with a Prisma row but no live vector under the active
      // identity are REFUSED, not stamped, so coverage cannot report a phantom
      // index. Tell the operator how many are still owed an embed.
      if (skipped > 0) {
        process.stdout.write(
          `Refused ${skipped} chunk(s): a row exists but the store holds no vector for them\n` +
            `under "${model}" (never embedded, or dropped by \`prepare --force\`). They keep\n` +
            `their old tag and still need a reindex: \`pnpm embeddings:migrate reindex --all\`.\n`,
        );
      }
      return 0;
    }

    case "discard": {
      if (!projectId) {
        process.stderr.write("Pass --project <id>.\n");
        return 2;
      }
      // Takes the SAME cross-process lease the reindex takes (#796 review B3, #798),
      // so a discard can never race an in-flight reindex on another replica and strand
      // it swapping a partial shadow into the live index.
      await getKnowledgeService().discardReindexShadow(projectId);
      process.stdout.write(`Discarded the reindex checkpoint for ${projectId}.\n`);
      return 0;
    }

    // Issue #798 — the operator escape hatch. The advisory lock this replaces could
    // leak across Prisma's connection pool and then only released on TCP disconnect,
    // so the ONLY way to clear one was to restart the pod. These two commands are what
    // "an operator can observe lock state and clear a stuck lock without restarting the
    // pod" means in practice.
    case "lock-status": {
      if (!projectId) {
        process.stderr.write("Pass --project <id>.\n");
        return 2;
      }
      const lease = await getKnowledgeService().reindexLockStatus(projectId);
      process.stdout.write(`${formatLockStatus(projectId, lease)}\n`);
      // Exit 1 when a lease is held, so this can gate a deploy check.
      return lease && !lease.expired ? 1 : 0;
    }

    case "unlock": {
      if (!projectId) {
        process.stderr.write("Pass --project <id>.\n");
        return 2;
      }
      const svc = getKnowledgeService();
      const lease = await svc.reindexLockStatus(projectId);
      const refusal = unlockRefusal(lease, { force: flag(argv, "force") });
      if (refusal) {
        process.stderr.write(`${refusal}\n`);
        return 2;
      }
      const cleared = await svc.forceReleaseReindexLock(projectId);
      if (!cleared) {
        process.stdout.write(`No reindex lease was held for ${projectId} — nothing to clear.\n`);
        return 0;
      }
      process.stdout.write(
        `Cleared the reindex lease for ${projectId} (holder "${cleared.holder}", last renewed ` +
          `${Math.round(cleared.ageMs / 1000)}s ago).\n` +
          `That holder is now FENCED: if it is somehow still alive it will abort at its next\n` +
          `batch rather than swap a partial index. Re-run the reindex when you are ready.\n`,
      );
      return 0;
    }

    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}\n`);
      return 2;
  }
}

main()
  .then((code) => {
    // #808 — `process.exitCode`, NOT `process.exit()`. Same class of bug as #785
    // (see `prefetch-embeddings-model.ts` and `embed-smoke.ts`): a successful
    // `status` or `reindex` run has just loaded the embedder, so onnxruntime-node
    // holds a live inference session on a native thread pool. `process.exit()`
    // tears the process down underneath it and ORT aborts:
    //
    //   libc++abi: terminating due to uncaught exception of type
    //   std::__1::system_error: mutex lock failed: Invalid argument
    //
    // which surfaces as **SIGABRT / exit 134** — so `embeddings:migrate reindex`
    // printed "... done" and then exited NON-ZERO, meaning any CI step, Helm
    // hook, or runbook script gating on `$?` sees a successful migration as a
    // failure. Reproduced on darwin/arm64, onnxruntime-node 1.21.0, after a real
    // 1,175-chunk reindex. Letting Node drain and exit naturally lets ORT release
    // the session first.
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`\n${(err as Error).message}\n`);
    // #808 — the same race applies here: a genuine failure mid-`reindex` can
    // still leave an ONNX session live (the embedder loaded before the error
    // hit), so this path gets the identical fix. `process.exitCode = 1` still
    // fails the process — it only changes WHEN the process actually exits.
    process.exitCode = 1;
  });
