/**
 * Epic #1156 / Issue #1160 — the DOCUMENT-retrieval eval corpus.
 *
 * ## Why this corpus exists at all
 *
 * `rag:eval` looks like the document-retrieval harness and is not. Its twenty
 * fixtures in `server/eval/rag-golden.jsonl` carry **canned** `retrievedChunks`
 * (`server/src/lib/rag/ragas.ts:42-43`) scored by a deterministic
 * `StubRagasJudge`, so it never runs retrieval. It is structurally incapable of
 * responding to a chunking change and would print identical numbers before and
 * after one — a vacuous pass, which is worse than no measurement because it
 * looks like evidence.
 *
 * `eval:embed-retrieval` is the wrong instrument for a different reason: it
 * measures NL → **code symbol** retrieval, and the code path embeds per symbol,
 * not per document chunk (ADR `docs/decisions/0002-symbol-level-rag-granularity.md`).
 * `DEFAULT_RAG_CHUNK_SIZE` does not participate in it at all.
 *
 * ## The one design constraint that decides whether the experiment means anything
 *
 * **Ground truth is anchored to a TEXT SPAN in the source document, never to a
 * chunk index.** A chunk index moves when the chunk size moves, so ground truth
 * expressed in chunk indices would change with the independent variable and the
 * experiment would measure nothing. Every query here names a verbatim `quote`
 * from its source document; {@link loadDocRetrievalCorpus} resolves that quote to
 * a character range once, and {@link import("./chunk-alignment.js").bestCoveringChunk}
 * derives the relevant chunk *per arm* from that fixed range. The corpus is
 * therefore valid at every chunk size without being edited — which is #1160's
 * acceptance criterion, and is asserted directly in `corpus.test.ts`.
 *
 * ## Why the corpus is real METIS documentation and not the `brd-0*` / `prd-0*` sets
 *
 * #1160 nominated the existing `eval-data/corpus/brd-0*`, `prd-0*` and `us-01`
 * requirement documents as candidate sources. **They cannot exercise this
 * variable.** Measured: every one of those twenty documents is between 408 and
 * 579 bytes, i.e. smaller than the SMALLEST chunk arm (768 characters), so each
 * is a single chunk at 768, 1024, 2048 and 3072 alike. A sweep over them would
 * produce four byte-identical chunkings and four identical scores — the same
 * vacuous pass this corpus exists to avoid.
 *
 * So the corpus snapshots ten real METIS documents from `docs/`. They are the
 * genuine artefact the document RAG path indexes: long, heading-structured
 * operational and architectural markdown with tables, code fences and prose.
 * The snapshot is frozen and carries a `snapshot-manifest.json` verified against
 * its declared `snapshotCommit` (never against HEAD — see
 * `server/scripts/write-corpus-snapshot-manifest.ts` for why that distinction is
 * load-bearing).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { corpusDir } from "../embed-retrieval/corpus.js";

/** The committed document-retrieval corpus. */
export const DEFAULT_DOC_CORPUS_ID = "docretrieval-01-metis-docs";

/**
 * The WIDE corpus (#1184) — twenty-two documents, 168 queries (198 before publication).
 *
 * ## Why a second corpus rather than an edit to the first
 *
 * `queriesNeededForHalfWidth` (`power-sizing.ts`), run over #1183's committed `all`
 * intervals, put the size arms at **101 / 177 / 190** queries to resolve their own
 * pre-registered +0.04 floor against the **48** available. So the size arms were never
 * merely null — they were **unresolved at the floor**, which the overlap arms (13 / 13 /
 * 32) were not. That asymmetry is what bought the expansion; see `power-sizing.ts` for the
 * inversion and `chunk-sweep.ts` for what the decision rule does with it.
 *
 * `docretrieval-01-metis-docs` is left exactly as it is, and this corpus is a strict
 * **superset** of it: the same `snapshotCommit`, the same nine documents byte-identical,
 * and its forty-three queries carried over byte-identically alongside a hundred and
 * twenty-five new ones over thirteen further documents from the same commit. Editing the first corpus
 * in place would have re-based the instrument mid-epic and destroyed the before/after
 * comparison #1183's and #1178's committed artefacts rest on — the resync failure mode
 * `write-corpus-snapshot-manifest.ts` exists to prevent. Both properties are asserted in
 * `corpus.test.ts` rather than left to this comment.
 *
 * **This is not the default**, and deliberately so: `DEFAULT_DOC_CORPUS_ID` is what the
 * committed #1160/#1178/#1183 artefacts were measured on, so silently redirecting it would
 * make those numbers unreproducible. Ask for this one by name:
 * `pnpm eval:doc-retrieval --corpus docretrieval-02-metis-docs-wide`.
 *
 * **Pruned for publication.** Before this repository was published, seven internal
 * documents were removed from both corpora together with the 35 queries anchored in them:
 * `docretrieval-01` went from 10 documents / 48 queries to 9 / 43, and this corpus from
 * 28 / 198 to 22 / 168. The superset relation above survives, because each removed
 * document left every corpus that held it. Two consequences are real rather than cosmetic. Every committed result that
 * says "48" or "198" was measured on the pre-publication corpus and will not reproduce
 * exactly here. And 168 is BELOW the 190 queries the size arms need to resolve their
 * +0.04 floor, so a size sweep over this corpus is once again unresolved at the floor —
 * `corpus.test.ts` asserts that shortfall rather than a pass.
 */
export const WIDE_DOC_CORPUS_ID = "docretrieval-02-metis-docs-wide";

/** Snapshot subdirectory holding the frozen source documents. */
export const DOC_SNAPSHOT_DIR = "docs";

/**
 * Minimum length of a ground-truth quote, in characters.
 *
 * A very short quote ("the cache") risks matching incidentally and carries too
 * little of the answer to justify calling a chunk relevant.
 */
export const MIN_SPAN_CHARS = 60;

/**
 * Maximum length of a ground-truth quote, in characters.
 *
 * This bound is not cosmetic — it is what keeps the metric comparable across
 * arms. Relevance is "the chunk that best covers the span", so a span shorter
 * than the smallest arm's chunk size can always be covered by a single chunk at
 * every arm. A span longer than a chunk would be *unrepresentable* at the small
 * arms and would silently punish them for the corpus's shape rather than for
 * their retrieval quality.
 */
export const MAX_SPAN_CHARS = 320;

/**
 * How a query is worded relative to its ground-truth span.
 *
 * `lexical` queries deliberately reuse the span's distinctive terms; `paraphrase`
 * queries ask for the same fact in different words. Reported as a stratum because
 * the two behave differently under chunking — and because #1159 was bitten by a
 * headline that survived only on its flattered subset.
 */
export type QueryPhrasing = "lexical" | "paraphrase";

/** One hand-authored query as committed in `queries.json`. */
export interface DocRetrievalQuerySpec {
  id: string;
  /** The natural-language question, as an engineer would type it. */
  question: string;
  /** Snapshot-relative path of the source document, e.g. `OPERATIONS.md`. */
  doc: string;
  /** A VERBATIM, UNIQUE substring of that document — the answer span. */
  quote: string;
  phrasing: QueryPhrasing;
}

/** The committed `queries.json` shape. */
export interface DocRetrievalCorpusSpec {
  corpusId: string;
  snapshotCommit: string;
  description: string;
  queries: DocRetrievalQuerySpec[];
}

/** A frozen source document. */
export interface DocRetrievalDoc {
  /** Snapshot-relative path, used as the document id throughout the harness. */
  id: string;
  text: string;
}

/** A query with its span resolved to absolute character offsets. */
export interface DocRetrievalQuery extends DocRetrievalQuerySpec {
  /** Inclusive character offset of the quote within its document. */
  spanStart: number;
  /** Exclusive character offset of the quote within its document. */
  spanEnd: number;
}

/** The loaded, validated corpus. */
export interface DocRetrievalCorpus {
  id: string;
  snapshotCommit: string;
  description: string;
  /** Synthetic project id used for the throwaway Prisma/vector-store namespace. */
  projectId: string;
  docs: DocRetrievalDoc[];
  queries: DocRetrievalQuery[];
}

/**
 * Resolve a quote to its unique character range in `text`.
 *
 * Throws on zero occurrences (a mistyped quote) and on more than one (an
 * ambiguous anchor). Both are corpus-authoring errors that must fail loudly at
 * load: a silently-dropped query shrinks n without telling anyone, and an
 * ambiguous anchor would make relevance depend on which occurrence was picked.
 */
export function resolveSpan(text: string, quote: string, queryId: string): [number, number] {
  const first = text.indexOf(quote);
  if (first === -1) {
    throw new Error(
      `Query "${queryId}": quote is not a substring of its document. ` +
        `Ground truth must be a VERBATIM span copied from the snapshot. ` +
        `Quote began: ${JSON.stringify(quote.slice(0, 60))}`,
    );
  }
  if (text.indexOf(quote, first + 1) !== -1) {
    throw new Error(
      `Query "${queryId}": quote occurs more than once in its document, so the ` +
        `ground-truth anchor is ambiguous. Extend the quote until it is unique. ` +
        `Quote began: ${JSON.stringify(quote.slice(0, 60))}`,
    );
  }
  return [first, first + quote.length];
}

/**
 * Words of `text`, lowercased, for {@link longestSharedWordRun}.
 *
 * Splits on anything that is not alphanumeric or `_`, so `pr_review.dlq` becomes
 * `pr_review` + `dlq` and `openssl rand -hex 32` becomes four words. Punctuation and
 * markdown emphasis are therefore invisible to the comparison, which is what makes a
 * question that copied its span's wording look copied even after it was re-punctuated.
 */
export function corpusWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 0);
}

/**
 * The longest run of CONSECUTIVE words a question shares with its answer span.
 *
 * ## Why a contiguous run is the PRIMARY instrument, and not the only one
 *
 * The discipline this measures is #1157's founding constraint: **a query is written from
 * the capability, never by paraphrasing the target text.** A query that copies its span's
 * wording hands BM25 the answer, inflates the lexical channel, and can invert a
 * conclusion — #1159's headline gain shrank from +0.053 to +0.022 once five
 * paraphrase-flattered queries were excluded.
 *
 * Raw bag-of-words overlap is the obvious detector and it is the wrong *primary* one, for
 * a reason that is measurable on the committed 168 rather than merely arguable. It cannot
 * separate *copying* from *being about the same thing* — every question about a document
 * reuses that document's nouns, so the statistic neither approaches 0 nor reaches 1
 * anywhere in this corpus (its range is 0.000–0.765, and **no query attains 1.00**). And
 * unweighted, it scores a function word exactly like a rare identifier. `dq-tms-02` and
 * `dq-lsv-02` both share a **three-word** run with their spans, so *this* function cannot
 * tell them apart — yet raw coverage ranks `dq-tms-02` HIGHER (0.714 against 0.545) while
 * IDF weighting inverts that outright (0.723 against **0.889**, the corpus maximum). Raw
 * coverage was reading `dq-tms-02`'s function words. That inversion is DERIVED in
 * `corpus.test.ts` rather than recalled here, so the example cannot drift away from the
 * corpus the way a hand-written one already has in this epic.
 *
 * A contiguous run separates restatement from shared subject: reusing a domain noun
 * phrase is unavoidable and short, while restating a sentence is long.
 *
 * **What a run cannot see.** BM25 is order-insensitive, so a query can donate every rare
 * term in its span, scattered, and still score a run of 1. That is a different failure and
 * it needs a different instrument: {@link idfWeightedQuestionCoverage} is reported beside
 * this one and bounds the other tail.
 *
 * Returns 0 when either side is empty.
 */
export function longestSharedWordRun(question: string, quote: string): number {
  const a = corpusWords(question);
  const b = corpusWords(quote);
  // Rolling one-row LCS-suffix table: `row[j]` is the length of the common run ENDING at
  // a[i-1]/b[j-1]. O(|a|·|b|) time, O(|b|) space; both sides are one sentence.
  let best = 0;
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0;
      if (row[j] > best) best = row[j];
      diagonal = above;
    }
  }
  return best;
}

/**
 * IDF over the corpus's OWN documents, as a lookup by word.
 *
 * `ln(1 + (N − df + 0.5) / (df + 0.5))` — the standard BM25 IDF, and specifically the one
 * `minisearch` applies underneath `server/src/lib/rag/bm25-index.ts`. Matching the
 * production formula is the point: a term this weights heavily is a term the lexical
 * channel being guarded against also weights heavily, so the audit and the failure mode
 * are denominated in the same units.
 *
 * A word in no document scores the df = 0 value rather than throwing. A question may
 * legitimately use a word the corpus never does, and such a word is maximally rare by
 * construction — but it is also, by construction, not shared with any span, so it can only
 * ever land in the denominator.
 */
export function buildCorpusIdf(docs: readonly DocRetrievalDoc[]): (word: string) => number {
  const total = docs.length;
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const word of new Set(corpusWords(doc.text))) df.set(word, (df.get(word) ?? 0) + 1);
  }
  return (word: string) => {
    const seen = df.get(word) ?? 0;
    return Math.log(1 + (total - seen + 0.5) / (seen + 0.5));
  };
}

/**
 * Share of a question's IDF mass that its answer span also contains — the SECOND dimension
 * of copy discipline, reported beside {@link longestSharedWordRun}.
 *
 * ## What this catches that a contiguous run cannot
 *
 * The channel #1157 worries about is BM25, and **BM25 is order-insensitive**. A query can
 * hand the lexical channel every rare term in its span, scattered, and still score a short
 * contiguous run: a run measures *sentence restatement*, this measures *rare-term
 * donation*, and they are different failures. On the committed 168, fourteen queries
 * clear 0.60 and **five of those have a run ≤ 2** — precisely the region a run alone is
 * blind to. `dq-lsv-02` is the extreme: run 3, coverage 0.889.
 *
 * ## Why the corpus ships with that tail in it, undisturbed
 *
 * Not because the tail is small. It is not, and no audit could make it so. Because of what
 * the tail does to the COMPARISON.
 *
 * #1159 was a between-CHANNEL A/B, where lexical flattery inflates one arm and not the
 * other — there it inverted the headline, which is why the exclusion was necessary. #1184
 * is a **paired, within-corpus comparison between chunkings**: every arm answers the same
 * 168 queries over the same text through the same hybrid path, so a flattered query is
 * flattered in *every* arm and the flattery is largely **common-mode** — it cancels in the
 * per-query delta that `all` is computed from. That, and not the audit, is what licenses
 * keeping all 168 queries whole. The audit bounds how bad the corpus is; the pairing is
 * what makes it not matter.
 *
 * The residual is that flattery could *interact* with chunk size rather than merely offset
 * it, and this cannot rule that out. Two things bound it. The effect is concentrated in
 * the stratum the corpus already declares and reports — mean coverage **0.349** on
 * `lexical` against **0.171** on `paraphrase`, and eleven of the fourteen above 0.60
 * are `lexical` against an 83/168 base rate — so it is visible rather than hidden. And per
 * #1183 the `arm-sensitive` stratum is published beside `all` for exactly this class of
 * question, as a diagnostic and never as the decision.
 *
 * Question terms are DEDUPLICATED, so a word repeated in the question is not weighted
 * twice. Returns 0 for a question with no words.
 */
export function idfWeightedQuestionCoverage(
  question: string,
  quote: string,
  idf: (word: string) => number,
): number {
  const questionTerms = new Set(corpusWords(question));
  const spanTerms = new Set(corpusWords(quote));
  let total = 0;
  let shared = 0;
  for (const term of questionTerms) {
    const mass = idf(term);
    total += mass;
    if (spanTerms.has(term)) shared += mass;
  }
  return total === 0 ? 0 : shared / total;
}

/** Absolute directory of a document-retrieval corpus. */
export function docCorpusDir(id: string = DEFAULT_DOC_CORPUS_ID): string {
  return corpusDir(id);
}

async function listMarkdown(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listMarkdown(path.join(dir, entry.name), rel)));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

/**
 * VALIDATE every query and resolve its span, or throw.
 *
 * Split out of {@link loadDocRetrievalCorpus} so the four rejections below are
 * reachable without materialising a broken corpus on disk. They are the contract, not
 * a nicety: each one would otherwise degrade the measurement quietly rather than
 * stopping it — a duplicate id silently overwrites a query, an unknown document
 * silently drops one, and an out-of-band quote silently punishes the small arms for
 * the corpus's shape.
 */
export function resolveQueries(
  specs: readonly DocRetrievalQuerySpec[],
  docsById: ReadonlyMap<string, DocRetrievalDoc>,
  corpusId: string,
): DocRetrievalQuery[] {
  const seen = new Set<string>();
  const queries: DocRetrievalQuery[] = [];
  for (const q of specs) {
    if (seen.has(q.id)) {
      throw new Error(`Duplicate query id "${q.id}" in ${corpusId}/queries.json`);
    }
    seen.add(q.id);
    const doc = docsById.get(q.doc);
    if (!doc) {
      throw new Error(
        `Query "${q.id}" names document "${q.doc}", which is not in the snapshot. ` +
          `Known documents: ${[...docsById.keys()].join(", ")}`,
      );
    }
    if (q.quote.length < MIN_SPAN_CHARS || q.quote.length > MAX_SPAN_CHARS) {
      throw new Error(
        `Query "${q.id}": quote is ${q.quote.length} characters, outside the ` +
          `[${MIN_SPAN_CHARS}, ${MAX_SPAN_CHARS}] band. A span longer than the smallest ` +
          `chunk arm cannot be covered by one chunk at that arm, which would punish ` +
          `small chunks for the corpus's shape rather than for their retrieval quality.`,
      );
    }
    const [spanStart, spanEnd] = resolveSpan(doc.text, q.quote, q.id);
    queries.push({ ...q, spanStart, spanEnd });
  }
  return queries;
}

/**
 * Load and VALIDATE the corpus.
 *
 * ## One caveat on generalising these results
 *
 * The ten snapshotted documents are heading-dense operational markdown, so
 * `chunkMarkdown`'s split-on-ATX-headings-FIRST behaviour dominates — which is exactly
 * why the reindex multiplier is 1.33× rather than 2×. That number, and the chunk-size
 * ordering it accompanies, may not transfer to a corpus of long unstructured prose.
 * They are the right corpus here because the document RAG path indexes precisely this
 * material.
 */
export async function loadDocRetrievalCorpus(
  id: string = DEFAULT_DOC_CORPUS_ID,
): Promise<DocRetrievalCorpus> {
  const dir = docCorpusDir(id);
  const spec = JSON.parse(
    await fs.readFile(path.join(dir, "queries.json"), "utf8"),
  ) as DocRetrievalCorpusSpec;

  const docsDir = path.join(dir, DOC_SNAPSHOT_DIR);
  const relPaths = await listMarkdown(docsDir).catch((error: NodeJS.ErrnoException) => {
    // #1382 untracked the snapshot, so on a fresh clone this directory does not
    // exist and the bare ENOENT names `scandir` rather than the one thing the
    // reader can do about it. The bytes are recoverable exactly — every file's
    // `source` and sha256 are in the corpus's committed `snapshot-manifest.json`.
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      `Corpus "${id}" has no ${DOC_SNAPSHOT_DIR}/ snapshot at ${docsDir}. It is ` +
        `gitignored since #1382 and is rebuilt from the corpus's snapshotCommit — ` +
        `run \`pnpm eval:restore-corpus\` (the root \`pnpm test\` runs it for you).`,
      { cause: error },
    );
  });
  const docs: DocRetrievalDoc[] = [];
  for (const rel of relPaths) {
    docs.push({ id: rel, text: await fs.readFile(path.join(docsDir, rel), "utf8") });
  }
  const byId = new Map(docs.map((d) => [d.id, d]));
  const queries = resolveQueries(spec.queries, byId, id);

  return {
    id: spec.corpusId,
    snapshotCommit: spec.snapshotCommit,
    description: spec.description,
    projectId: `eval-${spec.corpusId}`,
    docs,
    queries,
  };
}
