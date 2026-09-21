/**
 * Epic #1316 / Issue #1338 — the generated side, wired to the REAL corpus.
 *
 * Fifteen lines of glue with no rules of its own: it opens the doc-retrieval
 * harness's production retrieval session
 * (`../doc-retrieval/wired-harness.ts` → `openCorpusRetrieval`), pairs it with a
 * provider-backed synthesizer from `generate.ts`, and answers the corpus
 * questions that carry gold.
 *
 * It lives in its own module — rather than in `scripts/eval-answer-correctness.ts`
 * — for one reason: the harness imports `prisma`, whose driver adapter is built
 * at module load from `DATABASE_URL`. The script therefore reaches this file
 * through a dynamic `import()` AFTER pointing that variable at a throwaway
 * SQLite file, exactly as `scripts/eval-doc-retrieval.ts:74` does. A static
 * import in the script would bind the adapter to a developer's `dev.db` before
 * anything could redirect it.
 *
 * `openRetrieval` is injectable so the ORCHESTRATION here (which queries are
 * answered, in what order, what a retrieval session's lifetime is) is tested
 * with no database, no embedder and no provider.
 */
import type { AIProvider } from "../../ai/types.js";
import type { Embedder } from "../../rag/embedder.js";
import type { DocRetrievalCorpus } from "../doc-retrieval/corpus.js";
import {
  openCorpusRetrieval,
  type CorpusRetrievalOptions,
  type CorpusRetrievalSession,
} from "../doc-retrieval/wired-harness.js";
import { createProviderSynthesizer, generateAnswers, DEFAULT_ANSWER_K } from "./generate.js";
import type { GeneratedAnswer } from "./runner.js";

export interface CorpusAnswerOptions {
  corpus: DocRetrievalCorpus;
  provider: AIProvider;
  /** Directory the throwaway vector store lives under; the caller owns it. */
  tmpRoot: string;
  embedder: Embedder;
  /** Retrieval depth. Defaults to {@link DEFAULT_ANSWER_K}. */
  k?: number;
  /** Model override for the answer call. */
  model?: string;
  log?: (message: string) => void;
  signal?: AbortSignal;
  /** Injected in tests; defaults to the doc-retrieval harness. */
  openRetrieval?: (
    corpus: DocRetrievalCorpus,
    opts: CorpusRetrievalOptions,
  ) => Promise<CorpusRetrievalSession>;
}

/**
 * Answer the named queries against the corpus, through the production RAG path.
 *
 * `queryIds` is the set that carries gold — the runner passes it, and answering
 * anything else would be a model call whose output nothing can be compared to.
 * An id the corpus does not define is skipped with a log line rather than
 * throwing: `reference.json` is already validated against `queries.json` by
 * `validateReferenceSet`, so reaching here means the two drifted, and losing the
 * other 47 answers to it would help nobody.
 */
export async function generateCorpusAnswers(
  queryIds: readonly string[],
  opts: CorpusAnswerOptions,
): Promise<GeneratedAnswer[]> {
  const log = opts.log ?? ((): void => {});
  const wanted = new Set(queryIds);
  const queries = opts.corpus.queries.filter((q) => wanted.has(q.id));
  const missing = queryIds.filter((id) => !opts.corpus.queries.some((q) => q.id === id));
  for (const id of missing) log(`  ${id}: no such query in the corpus — not answered`);
  if (queries.length === 0) return [];

  const session = await (opts.openRetrieval ?? openCorpusRetrieval)(opts.corpus, {
    tmpRoot: opts.tmpRoot,
    embedder: opts.embedder,
    log,
  });

  return generateAnswers(
    queries.map((q) => ({ id: q.id, question: q.question })),
    {
      retrieve: session.search,
      synthesize: createProviderSynthesizer(opts.provider, {
        ...(opts.model ? { model: opts.model } : {}),
      }),
      k: opts.k ?? DEFAULT_ANSWER_K,
      log,
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );
}
