/**
 * Epic #1156 / Issue #1160 — `pnpm eval:doc-retrieval`.
 *
 * The DOCUMENT-retrieval eval arm. Unlike `rag:eval` — whose twenty fixtures carry
 * canned `retrievedChunks` scored by a stub judge, so it cannot see a chunking
 * change at all — this harness ingests a fixed document corpus through the
 * production chunker and embedder and queries it through the production
 * `KnowledgeService.search`. See `src/lib/eval/doc-retrieval/wired-harness.ts` for
 * exactly what is real and what is stood in for.
 *
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:doc-retrieval
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:doc-retrieval --corpus docretrieval-01-metis-docs
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:doc-retrieval --contextual headings
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:doc-retrieval --contextual headings,model
 *
 * `--contextual` (#2234) runs the contextual-chunks comparison instead of the size
 * sweep: the shipped 2048/256 index with contextual chunks `off`, against one arm
 * per listed mode. `model` calls the configured AI provider (`loadAIConfig()`) once
 * per chunk, with the document as a cached system prefix.
 *
 * Outputs a markdown table and a JSON artefact under `eval-results/`. Note that
 * directory is gitignored (`.gitignore:152`) and the committed files were
 * force-added — a run whose numbers are meant to be evidence needs `git add -f`.
 *
 * ## Why this file sets `DATABASE_URL` before importing anything
 *
 * `src/lib/prisma.ts` builds its driver adapter at module load from
 * `process.env.DATABASE_URL`. The harness writes `Document` rows and deletes
 * `KnowledgeChunk` rows, so it must own its database. Setting the variable first
 * and reaching the harness through a dynamic `import()` is what guarantees the
 * adapter is built against the throwaway SQLite file rather than a developer's
 * `dev.db`; `assertThrowawayDatabase` then re-checks it rather than trusting this
 * ordering to survive a refactor.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

/** `--<name> <value>` / `--<name>=<value>`. */
function parseFlag(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(`--${name}=`.length);
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return undefined;
}

/** `--corpus <id>` / `--corpus=<id>`. */
function parseCorpusId(argv: readonly string[]): string | undefined {
  return parseFlag(argv, "corpus");
}

/** #2234 — `--contextual headings,model`: the modes to compare against `off`. */
function parseContextualModes(argv: readonly string[]): ("headings" | "model")[] | undefined {
  const raw = parseFlag(argv, "contextual");
  if (raw === undefined) return undefined;
  const modes = raw.split(",").map((m) => m.trim());
  for (const m of modes) {
    if (m !== "headings" && m !== "model") {
      throw new Error(`--contextual takes headings and/or model, not "${m}"`);
    }
  }
  return modes as ("headings" | "model")[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS !== "1") {
    log(
      "eval:doc-retrieval needs the real embedder. Re-run with:\n" +
        "  EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:doc-retrieval\n" +
        "Never set EMBED_ALLOW_HASH_FALLBACK=1 to get past this — a hash arm is " +
        "chance-level and any number it prints is noise.",
    );
    process.exit(1);
  }
  if (process.env.EMBED_ALLOW_HASH_FALLBACK === "1") {
    log(
      "Refusing to run with EMBED_ALLOW_HASH_FALLBACK=1. The hash embedder is " +
        "chance-level; a chunk-size delta measured against it would be noise.",
    );
    process.exit(1);
  }

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "eval1160-"));
  const databaseUrl = `file:${path.join(tmpRoot, "doc-retrieval-eval.db")}`;
  process.env.DATABASE_URL = databaseUrl;

  try {
    // Dynamic imports ONLY after DATABASE_URL is set — see this file's header.
    const harness = await import("../src/lib/eval/doc-retrieval/wired-harness.js");
    const sweep = await import("../src/lib/eval/doc-retrieval/chunk-sweep.js");
    const { Embedder } = await import("../src/lib/rag/embedder.js");

    harness.assertThrowawayDatabase(databaseUrl, tmpRoot);
    log(`Throwaway database: ${databaseUrl}`);
    harness.pushSchema(databaseUrl);

    const embedder = new Embedder();
    await embedder.warm();
    log(`Embedder ready: ${embedder.model}`);

    const contextualModes = parseContextualModes(argv);
    if (contextualModes) {
      let generator;
      if (contextualModes.includes("model")) {
        const { buildProvider, loadAIConfig } = await import("../src/lib/ai/index.js");
        const { modelChunkContextGenerator } = await import("../src/lib/rag/contextual-chunks.js");
        const provider = buildProvider({ config: loadAIConfig() });
        log(`Chunk-context model: ${provider.key} ${provider.model}`);
        const live = modelChunkContextGenerator({
          provider: () => provider,
          // An eval ingests a whole corpus in one sitting; production keeps the default.
          concurrency: 12,
          onUsage: (u) => log(`  model context: ${JSON.stringify(u)}`),
        });
        // `--context-cache <file>` records every context and replays it on the next
        // run, so the arm can be finished across runs and re-scored for free.
        const cacheFile = parseFlag(argv, "context-cache");
        if (cacheFile) {
          const cache = await import("../src/lib/eval/doc-retrieval/context-cache.js");
          const recorded = await cache.readContextCache(cacheFile);
          log(`Context cache: ${Object.keys(recorded).length} recorded in ${cacheFile}`);
          generator = cache.cachedChunkContextGenerator(live, recorded, (c) =>
            writeFile(cacheFile, `${JSON.stringify(c)}\n`, "utf8"),
          );
        } else {
          generator = live;
        }
      }
      const report = await harness.runContextualComparison({
        corpusId: parseCorpusId(argv),
        embedder,
        tmpRoot,
        log,
        modes: contextualModes,
        generator,
      });
      const runId = new Date().toISOString().replace(/[:.]/g, "-");
      const resultsDir = path.join(REPO_ROOT, "eval-results");
      await mkdir(resultsDir, { recursive: true });
      const base = path.join(resultsDir, `doc-retrieval-contextual-${report.corpusId}-${runId}`);
      await writeFile(`${base}.md`, harness.renderContextualReport(report), "utf8");
      await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      log("");
      log(harness.renderContextualReport(report));
      log(`\nWrote ${base}.md`);
      return;
    }

    const report = await harness.runChunkSweep({
      corpusId: parseCorpusId(argv),
      embedder,
      tmpRoot,
      log,
    });

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const resultsDir = path.join(REPO_ROOT, "eval-results");
    await mkdir(resultsDir, { recursive: true });
    const mdPath = path.join(resultsDir, `doc-retrieval-chunk-sweep-${runId}.md`);
    const jsonPath = path.join(resultsDir, `doc-retrieval-chunk-sweep-${runId}.json`);
    await writeFile(mdPath, sweep.renderChunkSweep(report), "utf8");
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    log("");
    log(sweep.renderChunkSweep(report));
    log(`\nWrote ${mdPath}`);
    log(`Wrote ${jsonPath}`);
    log("`eval-results/` is gitignored — use `git add -f` to commit these.");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  log(`eval:doc-retrieval failed: ${(err as Error).stack ?? String(err)}`);
  // `process.exitCode` rather than `process.exit()` — the latter races
  // onnxruntime-node's native teardown and can abort mid-write (#785).
  process.exitCode = 1;
}
