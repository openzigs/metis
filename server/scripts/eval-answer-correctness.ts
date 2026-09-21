/**
 * Epic #1316 / Issue #1319 — `pnpm eval:answer-correctness` entrypoint.
 *
 *   pnpm eval:answer-correctness                    # validate + report the default corpus
 *   pnpm eval:answer-correctness --corpus <id>      # another corpus
 *   pnpm eval:answer-correctness --validate-only    # check reference.json, write nothing
 *
 * ## What this run does today
 *
 * It validates the corpus's `reference.json` — schema, style, provenance,
 * referential integrity against `queries.json`, and the snapshot commit — and
 * writes the answer-correctness fragment to
 * `eval-results/answer-correctness/<stamp>.json` and echoes it into the nightly
 * job summary.
 *
 * Since #1333 the envelope DOES reach the repository: `.gitignore` no longer
 * blanket-ignores `eval-results/`, and `answer-correctness/` is one of the two
 * outputs `scripts/eval-results-commit-guard.mjs` requires the nightly to
 * produce before it will commit. Between 2026-07-21 and that fix nothing under
 * `eval-results/` was committed at all — the old guard read
 * `git status --porcelain`, which does not list ignored files. Nothing here ever
 * worked around it with `git add -f`, because forcing past an ignore rule is how
 * material reaches a remote that was ignored precisely so it would not.
 *
 * With no human-authored gold answers committed yet it reports the metric as
 * **not reported**, with the reason, and exits 0. That is the honest state: a
 * mean of 0 over an empty reference set would read as a quality collapse, and a
 * model-generated gold answer would make the number circular (#1319).
 *
 * A malformed or non-human `reference.json` DOES exit non-zero — that is the
 * gate this script exists to be.
 *
 * ## Both sides are wired since #1338
 *
 * When (and only when) the corpus carries scorable gold answers, this script:
 *
 *   - resolves a provider-backed claim extractor + NLI judge from the #1317/#1318
 *     substrate (`src/lib/eval/answer-correctness/judge-deps.ts`), and
 *   - asks METIS the corpus questions through the doc-retrieval harness's own
 *     production retrieval path (`src/lib/eval/answer-correctness/corpus-answers.ts`).
 *
 * Both are LAZY. With `answers: []` — the state on `main` — neither a provider
 * nor a database nor the embedder is touched, so `pnpm test` and the nightly
 * stay hermetic and free. With gold but no provider, every score is
 * UNVERIFIABLE with a reason and NOTHING is a zero.
 *
 * The three "no number" outcomes are distinguishable in the output by their
 * `reasonCode`: `no-reference-file`, `no-gold-answers`, `no-generated-answers`
 * and `no-judge` (#1338). Before that they all read as one sentence, so an
 * author who filled `reference.json` and re-ran hit a second wall unlabelled.
 *
 * ## What the output leads with (#1342)
 *
 * Recall, then precision, then the F1 explicitly labelled `f1(length-sensitive)`
 * — and the envelope's computed `interpretation` line beneath it. The first real
 * run reported `mean=0.531` at `recall=1.000`, and that single blended figure
 * read as "METIS is 53% correct" when what it largely measured was METIS being
 * more complete than a reference the authoring guide caps at 1–3 sentences. See
 * `docs/decisions/0013-answer-correctness-reports-precision-and-recall.md`.
 *
 * ## Why the fragment is in a subdirectory
 *
 * `eval-results/*.json` is the domain-eval run store: `loadAllRuns` reads every
 * `.json` in that directory and parses it as a `DomainEvalRunResult`, dropping
 * anything that does not match. A fragment written beside them would be silently
 * skipped forever — a write nothing can read. `listRunIds` filters on the
 * `.json` suffix, so a subdirectory is invisible to it. Asserted in
 * `runner.test.ts`.
 *
 * ## Why every value import in `main()` is dynamic
 *
 * `src/lib/prisma.ts` builds its driver adapter at MODULE LOAD from
 * `process.env.DATABASE_URL`, and `src/lib/ai/index.js` transitively imports it.
 * A static `import { buildProvider }` at the top of this file therefore bound
 * Prisma to a developer's `dev.db` before anything could redirect it, and the
 * generator then seeded a `User`, a `Project` and one `Document` per corpus file
 * into that real database — with `assertThrowawayDatabase` passing, because it
 * checks the string the caller passes rather than what the client is bound to.
 * That was found by running this path for the first time (#1338) and is why
 * `assertPrismaOwnsDatabase` now exists as well.
 *
 * So: `DATABASE_URL` is repointed at a throwaway SQLite file FIRST, and every
 * value import happens after, through `import()`. Same rule and same reason as
 * `scripts/eval-doc-retrieval.ts`.
 *
 * ## Generating the answers needs the real embedder
 *
 * Retrieval runs the production chunker and embedder over the corpus, so the
 * generated side is gated behind `EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1` exactly as
 * `pnpm eval:doc-retrieval` is. Never set `EMBED_ALLOW_HASH_FALLBACK=1` to get
 * past it: the hash embedder is chance-level, and an answer written from
 * chance-level retrieval would be scored as if METIS had answered badly.
 *
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=… EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 \
 *     pnpm eval:answer-correctness
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// TYPE-ONLY. A value import here loads `src/lib/prisma.ts` before `main()` can
// repoint DATABASE_URL — see this file's header.
import type { ResolvedJudgeDeps } from "../src/lib/eval/answer-correctness/judge-deps.js";
import type { CorrectnessEnvelope } from "../src/lib/eval/answer-correctness/metric.js";
import type { GeneratedAnswer } from "../src/lib/eval/answer-correctness/runner.js";
import type { DocRetrievalCorpus } from "../src/lib/eval/doc-retrieval/corpus.js";

/** Duplicated rather than imported, for the same reason the imports are types. */
const DEFAULT_DOC_CORPUS_ID = "docretrieval-01-metis-docs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const RESULTS_DIR = path.join(REPO_ROOT, "eval-results", "answer-correctness");

/**
 * Read `--corpus`, rejecting anything that is not a plain corpus id.
 *
 * The value comes from a developer's shell rather than a request, but a path
 * traversal here would let a run read an arbitrary file and then COMMIT its
 * contents into `eval-results/` via the nightly. `docCorpusDir` contains the
 * resolved path as well; this is the cheaper of the two checks and it produces a
 * better message.
 */
export function parseCorpus(argv: readonly string[]): string {
  const i = argv.indexOf("--corpus");
  const next = i >= 0 ? argv[i + 1] : undefined;
  if (!next || next.startsWith("--")) return DEFAULT_DOC_CORPUS_ID;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(next)) {
    throw new Error(
      `invalid --corpus ${JSON.stringify(next)}: expected a corpus id like "${DEFAULT_DOC_CORPUS_ID}"`,
    );
  }
  return next;
}

/** Reason text when the real embedder was not enabled for this run. */
export const NO_EMBEDDER_REASON =
  "the generated side needs the real embedder: re-run with " +
  "EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 (never EMBED_ALLOW_HASH_FALLBACK=1, whose " +
  "hash arm is chance-level).";

/**
 * Whether this process may run the production embedder.
 *
 * Same gate as `pnpm eval:doc-retrieval`: the weights are a Hugging Face fetch,
 * and CI neither has them nor should pay for them.
 * @internal exported for testing.
 */
export function embedderAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS === "1" && env.EMBED_ALLOW_HASH_FALLBACK !== "1";
}

/**
 * Ask METIS the corpus questions — but ONLY when there is gold to compare the
 * answers against and something that could judge them.
 *
 * Returning `[]` here is not a silent failure: the runner reports
 * `no-generated-answers` (or `no-judge`, which takes precedence) with the
 * reason, and every score stays UNVERIFIABLE rather than becoming a zero.
 * @internal exported for testing.
 */
export function makeGenerator(
  corpus: DocRetrievalCorpus,
  judge: ResolvedJudgeDeps,
  log: (m: string) => void,
  db: { tmpRoot: string; databaseUrl: string },
): (queryIds: readonly string[]) => Promise<readonly GeneratedAnswer[]> {
  return async (queryIds) => {
    // `provider === null` and `unavailableReason !== null` are the same fact —
    // the union makes them one check, and this one also narrows the type.
    if (judge.provider === null) {
      log(`skipping answer generation — ${judge.unavailableReason}`);
      return [];
    }
    if (!embedderAllowed(process.env)) {
      log(`skipping answer generation — ${NO_EMBEDDER_REASON}`);
      return [];
    }
    const harness = await import("../src/lib/eval/doc-retrieval/wired-harness.js");
    const { generateCorpusAnswers } =
      await import("../src/lib/eval/answer-correctness/corpus-answers.js");
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    // Two guards, not one. The first says this run's URL is a throwaway file;
    // the second says the Prisma client is actually bound to THAT file and not
    // to a developer's dev.db (#1338).
    harness.assertThrowawayDatabase(db.databaseUrl, db.tmpRoot);
    harness.assertPrismaOwnsDatabase(db.databaseUrl);
    harness.pushSchema(db.databaseUrl);
    const embedder = new Embedder();
    await embedder.warm();
    log(`generating answers for ${queryIds.length} query(ies) — embedder ${embedder.model}`);
    return generateCorpusAnswers(queryIds, {
      corpus,
      provider: judge.provider,
      tmpRoot: db.tmpRoot,
      embedder,
      log,
    });
  };
}

/**
 * The lines this script prints for one envelope (#1342).
 *
 * Extracted from `run()` so the headline is testable: before #1342 it was
 * `mean=<f1>` and nothing else, and that single blended figure is exactly what
 * got read as "METIS is N% correct". It now leads with the two numbers that
 * answer different questions, labels the blend, and repeats the envelope's
 * computed interpretation — the JSON reaches the nightly job summary, but a
 * developer running this at a terminal sees only these lines.
 * @internal exported for testing.
 */
export function summariseEnvelope(corpusId: string, envelope: CorrectnessEnvelope): string[] {
  if (!envelope.reported) {
    return [
      `answer_correctness — corpus=${corpusId} NOT REPORTED [${envelope.reasonCode}]: ` +
        `${envelope.reason}`,
    ];
  }
  const agg = envelope.aggregate;
  // `aggregate` is optional on the type but present whenever `reported` is true
  // — `correctnessEnvelope` sets both together. Say so out loud rather than
  // optional-chaining past it: `scored=${agg?.scored}` would print the literal
  // string "undefined" into the metric line if that invariant ever slipped, and
  // a reader would take it for a formatting bug rather than a broken envelope.
  if (agg === undefined) {
    return [
      `answer_correctness — corpus=${corpusId} MALFORMED ENVELOPE: reported=true ` +
        "with no aggregate. This is a bug in correctnessEnvelope, not a bad run.",
    ];
  }
  const n = (v: number | null): string => (v === null ? "unverifiable" : v.toFixed(3));
  return [
    `answer_correctness — corpus=${corpusId} references=${envelope.referenceCount} ` +
      `recall=${n(agg.meanRecall)} precision=${n(agg.meanPrecision)} ` +
      `f1(length-sensitive)=${n(agg.meanF1)} scored=${agg.scored} ` +
      `unverifiable=${agg.unverifiable}`,
    ...(envelope.interpretation === undefined ? [] : [envelope.interpretation]),
  ];
}

async function main(): Promise<void> {
  const argv = process.argv;
  const corpusId = parseCorpus(argv);

  // OWN THE DATABASE BEFORE THE FIRST VALUE IMPORT. Everything below is an
  // `import()` for this reason alone — see the header. The directory is created
  // even on a run that never generates, because that is what makes the ordering
  // unconditional rather than something a future edit can quietly break.
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "eval1338-"));
  const databaseUrl = `file:${path.join(tmpRoot, "answer-correctness.db")}`;
  process.env.DATABASE_URL = databaseUrl;

  try {
    await run(argv, corpusId, { tmpRoot, databaseUrl });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function run(
  argv: readonly string[],
  corpusId: string,
  db: { tmpRoot: string; databaseUrl: string },
): Promise<void> {
  const { offlineJudgeDeps, resolveJudgeDeps } =
    await import("../src/lib/eval/answer-correctness/judge-deps.js");
  const { runAnswerCorrectness } = await import("../src/lib/eval/answer-correctness/runner.js");
  const { docCorpusDir, loadDocRetrievalCorpus } =
    await import("../src/lib/eval/doc-retrieval/corpus.js");
  const { buildProvider, loadAIConfig } = await import("../src/lib/ai/index.js");

  const corpusDir = docCorpusDir(corpusId);

  // Load the corpus so `reference.json` is validated against the query ids and
  // snapshot commit it actually claims to be ground truth for. Validating the
  // file in isolation would accept an answer for a query that does not exist.
  const corpus = await loadDocRetrievalCorpus(corpusId);

  /* eslint-disable no-console */
  const log = (m: string): void => console.log(m);

  // Resolving the judge is free and never throws — `resolveJudgeDeps` degrades a
  // credential failure into a REASON. `--validate-only` skips even that, so the
  // validation gate cannot be affected by provider configuration.
  const judge = argv.includes("--validate-only")
    ? offlineJudgeDeps("--validate-only: the judge was not resolved and nothing was scored.")
    : resolveJudgeDeps(() => buildProvider({ config: loadAIConfig() }));

  const envelope = await runAnswerCorrectness({
    corpusId,
    corpusDir,
    generate: makeGenerator(corpus, judge, log, db),
    deps: judge.deps,
    ...(judge.unavailableReason !== null ? { judgeUnavailable: judge.unavailableReason } : {}),
    validate: {
      expectedCorpusId: corpusId,
      expectedSnapshotCommit: corpus.snapshotCommit,
      knownQueryIds: corpus.queries.map((q) => q.id),
    },
  });

  for (const line of summariseEnvelope(corpusId, envelope)) console.log(line);
  if (envelope.licensePending) {
    console.log(
      `note: ${corpusId}/reference.json declares its licence PENDING — an open decision (#1322 E4, #1300).`,
    );
  }
  for (const f of envelope.corpusFindings ?? []) {
    console.log(`corpus finding — ${f.queryId} (${f.author}, ${f.date}): ${f.finding}`);
  }

  if (argv.includes("--validate-only")) return;

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(RESULTS_DIR, `${stamp}.json`);
  await writeFile(
    out,
    `${JSON.stringify(
      { ...envelope, commit: process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? null },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${path.relative(REPO_ROOT, out)}`);
  /* eslint-enable no-console */
}

// Only auto-run when executed directly as a script (tsx scripts/...). Importing
// this module — a unit test of `parseCorpus`, say — must not kick off a run that
// writes into `eval-results/`.
const invokedDirectly =
  typeof process.argv[1] === "string" && process.argv[1].includes("eval-answer-correctness");
if (invokedDirectly) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("eval:answer-correctness failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
