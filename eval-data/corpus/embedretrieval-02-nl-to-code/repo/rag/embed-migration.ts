/**
 * Issue #787 — the embedding-model migration service.
 *
 * ## What this is for
 *
 * #783 moved the default embedder from `Xenova/bge-small-en-v1.5` (384d, mean) to
 * `Alibaba-NLP/gte-modernbert-base` (768d, CLS) on the strength of #788's eval
 * (0.402 vs 0.246 nDCG@10 on NL-requirement → code retrieval). Every deployment
 * that already had an index therefore woke up with a VECTOR-SPACE MISMATCH: its
 * stored chunks are 384-dim (or hash vectors) while the live embedder emits
 * 768-dim.
 *
 * That state is SAFE — chunks are model-tagged and `KnowledgeService.search()`
 * filters to the active model, so an old vector is never mis-scored against a new
 * query; it is ignored, and BM25 keeps serving. But it is also DEGRADED: the dense
 * half of hybrid retrieval returns nothing until the corpus is re-embedded. This
 * module is how an operator gets out of it, and back into it if the new model
 * turns out to be worse for their corpus.
 *
 * ## What it does NOT do
 *
 * It invents no migration framework. The shadow build, the atomic per-project
 * cut-over, the resume checkpoint and the coverage accounting all live in
 * {@link KnowledgeService} (`reindexProject`, `reindexShadowId`,
 * `deploymentCoverage`). This module is the OPERATOR's view of them: what state am
 * I in, which projects still need work, and what is the one thing that has to
 * happen before any of it can work on pgvector.
 *
 * ## The pgvector trap
 *
 * On `VECTOR_STORE=pgvector` (the `values-prod` setting) every project shares ONE
 * `rag_vectors.embedding` column of type `vector(N)`. N is fixed at the column, so
 * a 384-dim deployment cannot hold a single 768-dim row — and
 * `CREATE TABLE IF NOT EXISTS … vector(768)` is a SILENT NO-OP against it. The
 * column must be migrated FIRST, which is destructive to the old vectors (not to
 * the chunk text they were derived from). {@link planMigration} refuses to let that
 * step be skipped, and refuses to let it happen by accident.
 */
import { createChildLogger } from "../logger.js";
import { Embedder, getEmbedder, type EmbedderHealth } from "./embedder.js";
import {
  getKnowledgeService,
  KnowledgeService,
  type DeploymentCoverageReport,
  type ReindexResult,
} from "./knowledge-service.js";
import type { ReindexLeaseInfo } from "./reindex-lease.js";
import { getVectorStore, type VectorStore } from "./vector-store.js";

const log = createChildLogger("embed-migration");

/** Which store backend is configured — mirrors `getVectorStore()`'s ladder. */
export type VectorStoreKind = "pgvector" | "local" | "lance";

export function vectorStoreKind(env: NodeJS.ProcessEnv = process.env): VectorStoreKind {
  if (env.AI_OFFLINE === "1" || env.AI_OFFLINE === "true") return "local";
  if ((env.VECTOR_STORE ?? "").trim().toLowerCase() === "local") return "local";
  if ((env.VECTOR_STORE ?? "").trim().toLowerCase() === "pgvector") return "pgvector";
  return "lance";
}

export interface MigrationStoreState {
  kind: VectorStoreKind;
  /**
   * The width the store's storage is FIXED at deployment-wide, or `null` when the
   * backend has no such thing (Lance is per-table; the local JSON store has none).
   */
  storedDimension: number | null;
  /**
   * True when a deployment-wide column/table dimension migration must run BEFORE
   * any project can be reindexed. pgvector only.
   */
  needsColumnMigration: boolean;
}

export interface MigrationStatus {
  embedder: EmbedderHealth;
  store: MigrationStoreState;
  coverage: DeploymentCoverageReport;
}

/** The ordered steps an operator must take to get from `status` to a healthy index. */
export interface MigrationPlan {
  /** Nothing to do — every chunk is already on the active model. */
  upToDate: boolean;
  /**
   * A BLOCKING problem: the migration cannot proceed at all. The embedder itself
   * is broken (bad backend, missing weights, an active hash fallback). Reindexing
   * now would fill the corpus with vectors from a model that is not the one the
   * deployment thinks it is running — the exact failure #783 made loud.
   */
  blocked: string | null;
  /** pgvector's destructive column-width step, when it is required. */
  needsColumnMigration: boolean;
  /** Projects with at least one chunk on a model other than the active one. */
  projectsToReindex: string[];
  steps: string[];
}

export interface MigrationDeps {
  knowledge: Pick<
    KnowledgeService,
    | "deploymentCoverage"
    | "reindexProject"
    | "reindexShadowState"
    | "discardReindexShadow"
    | "retagToActiveModel"
    // Issue #798 — the operator escape hatch: observe a reindex lease, and clear a
    // wedged one WITHOUT restarting the pod.
    | "reindexLockStatus"
    | "forceReleaseReindexLock"
  >;
  embedder: Pick<Embedder, "health">;
  store: VectorStore;
  kind: VectorStoreKind;
}

export function defaultMigrationDeps(): MigrationDeps {
  return {
    knowledge: getKnowledgeService(),
    embedder: getEmbedder(),
    store: getVectorStore(),
    kind: vectorStoreKind(),
  };
}

/**
 * Read the current migration state. Never throws for a broken embedder or an
 * un-migrated pgvector column — those are the very things it exists to REPORT, and
 * a status command that dies on the problem it is meant to diagnose is useless.
 */
export async function migrationStatus(deps: MigrationDeps): Promise<MigrationStatus> {
  const embedder = await deps.embedder.health();

  let storedDimension: number | null = null;
  if (deps.store.storedDimension) {
    try {
      storedDimension = await deps.store.storedDimension();
    } catch (err) {
      log.warn("could not read the store's stored dimension", { error: (err as Error).message });
    }
  }

  const coverage = await deps.knowledge.deploymentCoverage();

  return {
    embedder,
    store: {
      kind: deps.kind,
      storedDimension,
      // Independent of whether any chunk is indexed: an EMPTY 384-dim column still
      // has to be migrated before a 768-dim vector can be written into it, and an
      // operator who finds out at first-ingest rather than at `status` has been
      // failed by the tool.
      //
      // CALLER CONTRACT (PR #796 review): this compares the column against
      // `embedder.dimension`, which after a hash fallback is the STUB's width, not
      // the configured model's. That is the honest thing for a DIAGNOSTIC to report
      // — `migrationStatus()` is safe to call in any state precisely because it
      // makes no decisions. But it means every caller that ACTS on
      // `needsColumnMigration` owes a `planMigration().blocked` check first. Do not
      // add a command that skips it; use {@link prepareRefusal}.
      needsColumnMigration: storedDimension !== null && storedDimension !== embedder.dimension,
    },
    coverage,
  };
}

/**
 * Turn a status into an ordered set of operator actions.
 *
 * The `blocked` check comes first and is deliberately strict: an embedder that is
 * `degraded` (a hash fallback took over) or `error` must NOT be reindexed onto.
 * A reindex is the one operation that rewrites every vector in a project, so doing
 * it with the wrong embedder is the most expensive possible way to discover that
 * the embedder is wrong — and, because the hash stub tags its output with its own
 * model id, the result would LOOK like a successful migration to a different model.
 */
export function planMigration(status: MigrationStatus): MigrationPlan {
  const blocked =
    status.embedder.status === "error"
      ? `The embedder is not usable (${status.embedder.error ?? "unknown error"}). ` +
        `Fix the backend before reindexing — a reindex rewrites every vector in the project.`
      : status.embedder.fellBack
        ? `The embedder has fallen back to the hash stub (EMBED_ALLOW_HASH_FALLBACK), which ` +
          `produces NON-SEMANTIC vectors. Reindexing now would rewrite the corpus with noise. ` +
          `Fix the real backend first.`
        : null;

  const projectsToReindex = status.coverage.projects
    .filter((p) => p.needsReindex)
    .map((p) => p.projectId);

  const upToDate =
    blocked === null && !status.store.needsColumnMigration && projectsToReindex.length === 0;

  const steps: string[] = [];
  if (blocked) {
    steps.push(`BLOCKED: ${blocked}`);
    return { upToDate: false, blocked, needsColumnMigration: false, projectsToReindex, steps };
  }
  if (status.store.needsColumnMigration) {
    steps.push(
      `Migrate the shared pgvector column from ${String(status.store.storedDimension)}d to ` +
        `${status.embedder.dimension}d: \`pnpm embeddings:migrate prepare --force\`. This DROPS the ` +
        `old vectors (not the chunk text) — pg_dump -t rag_vectors first if you want a fast ` +
        `rollback. Every project must then be reindexed.`,
    );
  }
  for (const projectId of projectsToReindex) {
    steps.push(`Reindex ${projectId}: \`pnpm embeddings:migrate reindex --project ${projectId}\``);
  }
  if (steps.length === 0) steps.push("Nothing to do — every chunk is on the active model.");

  return {
    upToDate,
    blocked: null,
    needsColumnMigration: status.store.needsColumnMigration,
    projectsToReindex,
    steps,
  };
}

/**
 * PR #796 review (B1) — the gate `prepare` must pass BEFORE it drops anything.
 * Returns an operator-facing refusal, or `null` when the migration may proceed.
 *
 * `prepare` is the one DESTRUCTIVE command in this CLI — it drops every vector in
 * the deployment and rebuilds the shared column — and it originally checked only
 * `needsColumnMigration` and `--force`. `reindex` checked `planMigration().blocked`;
 * `prepare` did not. That inverts the risk, and the hash-fallback walk is the proof:
 *
 *   1. `EMBED_ALLOW_HASH_FALLBACK` is on and the real backend fails to warm, so
 *      `getEmbedder()` now reports the STUB's model id and the STUB's dimension.
 *   2. `migrationStatus()` compares the 768d column against the stub's width and
 *      reports `needsColumnMigration: true` — correctly; it is a diagnostic.
 *   3. The operator, following the runbook, runs `prepare --force`.
 *   4. Every vector in every project is dropped and the column is rebuilt at the
 *      HASH STUB's width.
 *   5. Only THEN does `reindex` refuse, because the embedder is blocked. The
 *      vectors are already gone.
 *
 * `--force` gates the operator's INTENT. It says nothing about the system's FITNESS,
 * and a column migration is more expensive to get wrong than a reindex: it is
 * fleet-wide and it is not resumable. So the health gate comes first, and `--force`
 * second. (`PgVectorStore.migrateColumnDimension()` carries the same refusal
 * independently, for callers that are not this CLI.)
 */
export function prepareRefusal(status: MigrationStatus, opts: { force: boolean }): string | null {
  const plan = planMigration(status);
  if (plan.blocked) {
    return (
      `REFUSING to prepare. ${plan.blocked}\n` +
      `\`prepare\` DROPS every vector in the deployment and rebuilds the shared column at the ` +
      `width the ACTIVE embedder reports — which, in this state, is not the width of the model ` +
      `you think you are migrating to.`
    );
  }
  if (!opts.force) {
    return (
      `REFUSING to migrate the shared pgvector column from ` +
      `${String(status.store.storedDimension)}d to ${status.embedder.dimension}d without --force.\n\n` +
      `This DROPS every stored vector. It does NOT drop the chunk text they were built\n` +
      `from (that lives in KnowledgeChunk), so every project is exactly one\n` +
      `\`reindex\` away from a working index — but dense retrieval is BM25-only in\n` +
      `between, and on a large corpus that window is measured in hours.\n\n` +
      `Take a backup first if you want a rollback that skips the re-embed:\n` +
      `  pg_dump "$DATABASE_URL" -t rag_vectors > rag_vectors.sql\n` +
      `(restore it, then \`retag --force\` — see docs/EMBEDDINGS_BACKENDS.md § Rollback)\n\n` +
      `Then re-run with --force.`
    );
  }
  return null;
}

/**
 * PR #796 review (S2) — the gate `retag` must pass. Returns a refusal or `null`.
 *
 * `retag` re-labels every chunk with the active model WITHOUT re-embedding, which is
 * only ever correct in ONE situation: an operator has just restored a `pg_dump` of
 * `rag_vectors` taken while that model was active, and needs the Prisma tags to
 * agree with the vectors they put back. In every other state it makes coverage LIE —
 * it will report a healthy index built from a model that never touched those rows.
 *
 * So it is gated harder than `reindex`, not softer:
 *   - a DEGRADED embedder is refused (the tags would name the hash stub);
 *   - a column-width mismatch is refused — it proves the stored vectors were NOT
 *     produced by the active model, so there is nothing here worth vouching for;
 *   - and `--force`, because this rewrites the tag on every chunk in the deployment.
 */
export function retagRefusal(status: MigrationStatus, opts: { force: boolean }): string | null {
  const plan = planMigration(status);
  if (plan.blocked) {
    return (
      `REFUSING to retag. ${plan.blocked}\n` +
      `Retagging would stamp every chunk in the deployment with the model this embedder ` +
      `REPORTS — which, in this state, is not the model that produced the vectors.`
    );
  }
  if (status.store.needsColumnMigration) {
    return (
      `REFUSING to retag: the shared pgvector column is ` +
      `${String(status.store.storedDimension)}d but the active embedder emits ` +
      `${status.embedder.dimension}d.\n` +
      `A width mismatch PROVES the stored vectors were not produced by the active model, so ` +
      `tagging them as if they were would make \`status\` report an index that does not exist. ` +
      `Restore the matching pg_dump first, or run \`prepare --force\` + \`reindex --all\`.`
    );
  }
  if (!opts.force) {
    return (
      `REFUSING to retag without --force.\n\n` +
      `\`retag\` re-labels EVERY chunk in the deployment as "${status.embedder.model}" WITHOUT ` +
      `re-embedding.\nIt is correct in exactly one situation: you have just restored a ` +
      `pg_dump of rag_vectors\ntaken while this model was active, and the tags need to catch up ` +
      `with the vectors.\n\n` +
      `If you have NOT restored a dump, you want \`reindex --all\` instead — retagging would ` +
      `make\ncoverage report an index that is not there.\n\n` +
      `Then re-run with --force.`
    );
  }
  return null;
}

export interface ReindexAllOptions {
  /** Reindex every project, not just the ones with a model mismatch. */
  all?: boolean;
  batchSize?: number;
  fresh?: boolean;
  onProject?: (projectId: string, index: number, total: number) => void;
  onProgress?: (projectId: string, processed: number, total: number) => void;
}

export interface ReindexAllResult {
  results: ReindexResult[];
  failures: Array<{ projectId: string; error: string }>;
}

/**
 * Reindex every project that needs it, ONE AT A TIME.
 *
 * Sequential on purpose. A reindex is embed-bound, and the embedder — whether it
 * is the in-process ONNX runtime or the sidecar — is a single shared, CPU-bound
 * resource. Running projects in parallel would not make the migration finish
 * sooner; it would multiply the peak memory and make the progress output
 * unreadable. It would also multiply the number of half-built shadows a pod
 * eviction leaves behind.
 *
 * A project that fails does NOT abort the run: its shadow is retained (so it can
 * be resumed later) and the remaining projects still get migrated. Failures are
 * returned, not thrown — a migration that stops at the first bad project is a
 * migration an operator has to babysit.
 */
export async function reindexAll(
  deps: MigrationDeps,
  opts: ReindexAllOptions = {},
): Promise<ReindexAllResult> {
  const coverage = await deps.knowledge.deploymentCoverage();
  const targets = (opts.all ? coverage.projects : coverage.projects.filter((p) => p.needsReindex))
    // Issue #797 — a project with SYMBOLS but no documents (a repo-only project)
    // still has work to do. Filtering on `totalChunks > 0` alone would skip it
    // and leave its symbol vectors on the previous model forever.
    .filter((p) => p.totalChunks > 0 || p.totalSymbols > 0)
    .map((p) => p.projectId);

  const results: ReindexResult[] = [];
  const failures: Array<{ projectId: string; error: string }> = [];

  for (const [i, projectId] of targets.entries()) {
    opts.onProject?.(projectId, i + 1, targets.length);
    try {
      const result = await deps.knowledge.reindexProject(projectId, {
        ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
        ...(opts.fresh !== undefined ? { fresh: opts.fresh } : {}),
        onProgress: ({ processed, total }) => opts.onProgress?.(projectId, processed, total),
      });
      results.push(result);
    } catch (err) {
      const message = (err as Error).message;
      failures.push({ projectId, error: message });
      log.error("project reindex failed during migration", { projectId, error: message });
    }
  }

  return { results, failures };
}

/**
 * Issue #798 — render a project's reindex lease for `embeddings:migrate lock-status`.
 *
 * The whole point of the lease (over the advisory lock it replaces) is that this
 * question has an ANSWER an operator can act on: not "is something locked" but WHO
 * holds it, how long ago they last proved they were alive, and whether it has already
 * lapsed. A LIVE lease means wait; an EXPIRED one means the holder died and the next
 * attempt will simply take it.
 */
export function formatLockStatus(projectId: string, lease: ReindexLeaseInfo | null): string {
  if (!lease) {
    return (
      `No reindex lease is held for ${projectId}.\n` +
      `(On a non-Postgres runtime there is no cross-process lease at all — a single ` +
      `process is the only writer.)`
    );
  }
  const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;
  const lines = [
    `Reindex lease for ${projectId}`,
    "=".repeat(60),
    `Holder        ${lease.holder}`,
    `Last renewed  ${seconds(lease.ageMs)} ago`,
    `Expires       ${new Date(lease.expiresAt).toISOString()}`,
    `State         ${lease.expired ? "EXPIRED" : "LIVE"}`,
    "",
  ];
  lines.push(
    lease.expired
      ? `The holder stopped renewing — it was killed (pod eviction, OOM, SIGKILL) or is\n` +
          `partitioned. The lease is STALE: the next reindex or discard simply takes it, and\n` +
          `the old run is FENCED (it can no longer upsert or swap). You do not have to do\n` +
          `anything — and you never have to restart a pod.\n\n` +
          `To clear it now: pnpm embeddings:migrate unlock --project ${projectId} --force`
      : `A reindex is ACTIVE on this project (the holder renewed ${seconds(lease.ageMs)} ago).\n` +
          `Reindex and discard will be refused with 409 until it finishes. Only unlock this\n` +
          `if you know the holder is gone — the run will be fenced and will have to re-run.`,
  );
  return lines.join("\n");
}

/**
 * Issue #798 — the gate `unlock` must pass. Returns a refusal, or `null` to proceed.
 *
 * A LIVE lease + no `--force` is refused: the operator is told who holds it and how
 * recently they renewed, so the decision is informed rather than reflexive. Clearing
 * a live lease is SAFE (the holder is fenced, so the worst case is a re-run, never a
 * partial index) — but it is not free, and a reindex is expensive to throw away.
 */
export function unlockRefusal(
  lease: ReindexLeaseInfo | null,
  opts: { force: boolean },
): string | null {
  if (!lease) return null;
  if (lease.expired || opts.force) return null;
  return (
    `REFUSING to unlock: the lease is LIVE.\n` +
    `  holder       ${lease.holder}\n` +
    `  last renewed ${Math.round(lease.ageMs / 1000)}s ago\n\n` +
    `A holder that is renewing is a reindex that is RUNNING. Clearing its lease FENCES it:\n` +
    `it will abort at its next batch rather than corrupt anything, but the work is lost and\n` +
    `it must be re-run.\n\n` +
    `If the holder really is gone (its pod was killed), wait for the lease to expire — the\n` +
    `next attempt takes it automatically — or re-run with --force.`
  );
}

/** Render a {@link MigrationStatus} + {@link MigrationPlan} as operator-facing text. */
export function formatStatus(status: MigrationStatus, plan: MigrationPlan): string {
  const lines: string[] = [];
  const e = status.embedder;
  lines.push("Embedding migration status");
  lines.push("=".repeat(60));
  lines.push(`Embedder      ${e.model} (${e.dimension}d, backend "${e.backend}")`);
  lines.push(
    `Health        ${e.status}${e.fellBack ? " — HASH FALLBACK ACTIVE (vectors are NOT semantic)" : ""}`,
  );
  if (e.error) lines.push(`Error         ${e.error}`);
  lines.push(
    `Vector store  ${status.store.kind}` +
      (status.store.storedDimension !== null
        ? ` (column is ${status.store.storedDimension}d)`
        : ""),
  );
  if (status.store.needsColumnMigration) {
    lines.push(
      `              ^ MISMATCH: the column is ${String(status.store.storedDimension)}d but the ` +
        `embedder emits ${e.dimension}d. No project can be reindexed until this is migrated.`,
    );
  }
  lines.push("");
  lines.push(
    `Chunks        ${status.coverage.totalChunks} across ${status.coverage.projects.length} project(s)`,
  );
  const models = Object.entries(status.coverage.modelCounts).sort((a, b) => b[1] - a[1]);
  if (models.length === 0) {
    lines.push("              (no chunks indexed)");
  }
  for (const [model, count] of models) {
    const pct =
      status.coverage.totalChunks > 0 ? Math.round((count / status.coverage.totalChunks) * 100) : 0;
    const active = model === status.coverage.currentModel ? "  <- active" : "";
    lines.push(
      `              ${String(pct).padStart(3)}%  ${String(count).padStart(7)}  ${model}${active}`,
    );
  }
  lines.push("");
  // Issue #797 — code-symbol embeddings, reported SEPARATELY from document
  // chunks. They are a distinct corpus in a distinct namespace and they migrate
  // as their own phase; folding them into the chunk totals would hide a
  // half-migrated deployment behind one aggregate percentage. `(pending)` means
  // the ingest wrote the row but the background embed job has not run yet.
  lines.push(`Code symbols  ${status.coverage.totalSymbols}`);
  const symbolModels = Object.entries(status.coverage.symbolModelCounts).sort(
    (a, b) => b[1] - a[1],
  );
  if (symbolModels.length === 0) {
    lines.push("              (no symbols indexed)");
  }
  for (const [model, count] of symbolModels) {
    const pct =
      status.coverage.totalSymbols > 0
        ? Math.round((count / status.coverage.totalSymbols) * 100)
        : 0;
    const active = model === status.coverage.currentModel ? "  <- active" : "";
    const label = model === "" ? "(pending — not embedded yet)" : model;
    lines.push(
      `              ${String(pct).padStart(3)}%  ${String(count).padStart(7)}  ${label}${active}`,
    );
  }
  lines.push("");
  lines.push(
    `Projects needing reindex: ${status.coverage.projectsNeedingReindex}/${status.coverage.projects.length}`,
  );
  for (const p of status.coverage.projects.filter((x) => x.needsReindex)) {
    lines.push(
      `  ${p.projectId}  ${p.matchingChunks}/${p.totalChunks} on the active model  ` +
        `(${Object.keys(p.modelCounts).join(", ")})`,
    );
  }
  lines.push("");
  lines.push(plan.upToDate ? "Up to date." : "Next steps:");
  if (!plan.upToDate) {
    for (const [i, step] of plan.steps.entries()) lines.push(`  ${i + 1}. ${step}`);
  }
  return lines.join("\n");
}
