/**
 * Epic #780 / Issue #788, enlarged and stratified by Epic #1156 / Issue #1157 —
 * the NL-requirement → code retrieval corpus.
 *
 * ## What the corpus is (stated plainly — it is hand-built)
 *
 * A corpus directory under `eval-data/corpus/<id>/` contains:
 *
 *   - `repo/` — a VERBATIM SNAPSHOT of real METIS source files (taken from
 *     `server/src/lib/**` and `metis-sql-lineage/app/**` at a recorded commit).
 *     Real enterprise TypeScript and Python, real symbol names, real bodies —
 *     not synthesized toy code. It is a snapshot (not a live read of
 *     `server/src`) so the eval is deterministic and does not break every time
 *     someone refactors an unrelated file.
 *   - `schema/` — OPTIONAL. ORM sources (a `schema.prisma` excerpt) from which
 *     SQL `table`/`column` symbols are materialised through the PRODUCTION ORM
 *     extractor; see {@link buildSchemaSymbolsFromOrm}. Absent for
 *     `embedretrieval-01`, which is why that corpus is unchanged by this module.
 *   - `queries.json` — HAND-AUTHORED natural-language requirements, each mapped
 *     to the symbol(s) that implement it. Ground truth was established by a
 *     human reading the snapshot's code and writing the requirement an analyst
 *     would have written for it; there is no automated or LLM-derived labelling.
 *     Every requirement is phrased in requirement register ("The system
 *     must…"), NOT as a keyword query.
 *
 * Symbols are parsed out of the snapshot with METIS's OWN parser (reusing
 * {@link buildSymbolsFromRepo} from the #717 code-graph eval), and each symbol's
 * indexable text is produced by the PRODUCTION formatter
 * ({@link formatSymbolForEmbedding}) — the exact text `SymbolEmbeddingPipeline`
 * writes to the vector store. So the vectors this eval scores are the vectors
 * production would have written.
 *
 * Every symbol in the snapshot that is NOT a query's target acts as a
 * distractor, which is what makes the ranking task non-trivial.
 *
 * ## `docs` ⊂ `searchable`, and the asymmetry is production's, not a shortcut
 *
 * `searchable` is the BM25 lexical index; `docs` is the set that gets a vector.
 * They are NOT the same set, because in production they are not the same set:
 * `prismaSymbolIndex` (`project-code-searcher.ts`) selects EVERY `CodeSymbol`
 * row for the project with no `kind` filter, so `table`/`column` symbols are in
 * the lexical index — but the ONLY writer of `CodeSymbolEmbedding` rows is the
 * per-parsed-file loop in `ingest.ts` (the single `codeSymbolEmbedding.createMany`
 * call), and `SchemaGraphWriter.ensureTable`/`ensureColumn` write a `CodeSymbol`
 * and nothing else. A SQL symbol therefore has NO vector in production and is
 * reachable through the lexical channel alone.
 *
 * Modelling that faithfully is load-bearing for epic #1156: give the SQL stratum
 * vectors it does not have in production and the vector channel answers queries
 * production cannot answer, which would invert sub-issue #1159's conclusion about
 * snake_case lexical matching.
 */
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSymbolsFromRepo, type EvalCodeSymbol } from "../codegraph/fixture.js";
import {
  formatSymbolForEmbedding,
  type SymbolForEmbedding,
  type SymbolKind,
} from "../../code-graph/symbol-embeddings.js";
import { extractOrm } from "../../code-graph/orm-extractor.js";
import { columnQualifiedName, tableQualifiedName } from "../../code-graph/schema-graph.js";
import { tokenizeCode, type SearchableSymbol } from "../../code-graph/hybrid-search.js";

/** Project id used to scope the in-memory index. */
export const EMBED_RETRIEVAL_PROJECT_ID = "embed-retrieval-eval-project";

/** The corpus the CLI and the harness default to (#1157). */
export const DEFAULT_CORPUS_ID = "embedretrieval-02-nl-to-code";

/** The original 30-query corpus, kept addressable by id (#1157 scope item 5). */
export const LEGACY_CORPUS_ID = "embedretrieval-01-nl-to-code";

/** Filename of the per-corpus provenance record. See {@link SnapshotManifest}. */
export const SNAPSHOT_MANIFEST_FILE = "snapshot-manifest.json";

/**
 * Where each snapshot subtree was copied FROM, relative to the repo root.
 *
 * Only full-file copies appear here. `schema/` is deliberately absent: it holds a
 * 14-model EXCERPT of `server/prisma/schema.prisma`, which is byte-identical to no
 * file at any commit, so it carries a content hash and no provenance claim.
 */
export const SNAPSHOT_SOURCE_ROOTS: Readonly<Record<string, string>> = {
  repo: "server/src/lib",
  "repo/sql-lineage": "metis-sql-lineage/app",
  docs: "docs",
};

/**
 * Snapshot files that were copied from a source but have since been REDACTED, so
 * they are no longer byte-identical to it and may not claim provenance (#1382).
 *
 * The publishable tree may carry no company identifier (#1373). One snapshot file
 * was frozen from a commit that still contained one, so the identifier had to be
 * removed from the copy — and the moment it was, `git show <snapshotCommit>:<source>`
 * stopped agreeing with the file on disk. The manifest's honest representation of
 * that is `source: null`: hashed from the committed file, drift still caught, no
 * provenance claim made. This map is what makes that choice SURVIVE a regeneration —
 * `write-corpus-snapshot-manifest.ts` consults it, so re-running the writer cannot
 * silently restore a `source` the file no longer matches.
 *
 * Keys are snapshot-relative paths; values say why the redaction happened.
 */
export const REDACTED_SNAPSHOT_FILES: Readonly<Record<string, string>> = {
  "repo/docs-gen/grounding/degraded-warnings.ts":
    "a company identifier in a prose comment was replaced with a neutral placeholder " +
    "before publication (#1373, #1382); the rest of the file is the snapshot verbatim",
};

/**
 * Snapshot subtrees the manifest writer walks.
 *
 * `docs/` belongs to the #1160 DOCUMENT-retrieval corpus
 * (`docretrieval-01-metis-docs`); `repo/` and `schema/` belong to the NL→code
 * corpora. A corpus simply has no directory for the subtrees it does not use, and
 * the walk skips what is absent — so all corpora share one writer.
 */
export const SNAPSHOT_SUBTREES: readonly string[] = ["repo", "schema", "docs"];

/**
 * Map a snapshot-relative path to the repo path it was copied FROM, or `null`.
 *
 * `null` means "make no provenance claim for this file", and there are exactly two
 * ways to earn it: the path is not under any snapshot source root (the `schema/`
 * excerpt), or it is a {@link REDACTED_SNAPSHOT_FILES} entry whose bytes deliberately
 * no longer match the source.
 *
 * It lives here, beside the two constants it reads, rather than inside
 * `server/scripts/write-corpus-snapshot-manifest.ts` where it began — a script's
 * private function is reachable by no test, and the redaction short-circuit is exactly
 * the line whose absence would be invisible: the manifest on disk would still look
 * right, and only the NEXT regeneration would quietly restore a `source` the redacted
 * file cannot support (#1382).
 *
 * LONGEST prefix wins: `repo/sql-lineage/api.py` came from `metis-sql-lineage/app`,
 * and a plain first-match over `repo` would have mapped it to
 * `server/src/lib/sql-lineage/api.py`, which does not exist.
 */
export function snapshotSourceFor(rel: string): string | null {
  // Checked FIRST, before any prefix matching — a redacted file must never re-derive
  // a source, however well its path matches one.
  if (REDACTED_SNAPSHOT_FILES[rel]) return null;
  const prefixes = Object.keys(SNAPSHOT_SOURCE_ROOTS).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (rel.startsWith(`${prefix}/`)) {
      return `${SNAPSHOT_SOURCE_ROOTS[prefix]}/${rel.slice(prefix.length + 1)}`;
    }
  }
  return null;
}

/** One file's entry in a {@link SnapshotManifest}. */
export interface SnapshotManifestEntry {
  /** Hex sha256 of the file's bytes AT `snapshotCommit` (or of the excerpt itself). */
  sha256: string;
  /** Repo-relative path this file was copied from, or `null` for an excerpt. */
  source: string | null;
}

/**
 * The provenance record committed beside a corpus (PR #1174 review).
 *
 * It exists so the drift check can assert "the corpus matches what it SAYS it
 * snapshotted" — a claim that stays true as `main` moves on — instead of "the
 * corpus matches HEAD", which is a claim a frozen corpus must never make. See
 * `server/scripts/write-corpus-snapshot-manifest.ts` for the reasoning in full.
 */
export interface SnapshotManifest {
  corpusId: string;
  snapshotCommit: string;
  algorithm: "sha256";
  note: string;
  files: Record<string, SnapshotManifestEntry>;
}

/** Read a corpus's committed {@link SnapshotManifest}. */
export async function loadSnapshotManifest(dir: string): Promise<SnapshotManifest> {
  return JSON.parse(
    await fs.readFile(path.join(dir, SNAPSHOT_MANIFEST_FILE), "utf8"),
  ) as SnapshotManifest;
}

/**
 * The declared strata (#1157). Both are DERIVED PROPERTIES of a hand-authored
 * requirement, not editorial labels — {@link deriveStrata} computes them from the
 * PRODUCTION {@link tokenizeCode}, and `corpus.test.ts` fails if a committed
 * declaration disagrees with what the tokenizer actually says. A stratum you can
 * only assert is a stratum that silently rots.
 */
export interface QueryStrata {
  /**
   * `snake` iff at least one target symbol's name carries an underscore, i.e. a
   * name production's `tokenizeCode` does NOT split (`order_status` stays one
   * term). This is the stratum sub-issue #1159 is judged on.
   */
  naming: "camel" | "snake";
  /**
   * `true` iff the requirement shares NO word with any target's `name` +
   * `qualifiedName` — the whole of what production BM25 indexes (see
   * `BM25Index.buildDocumentText`). No lexical channel can retrieve such a query
   * at any depth, so this is the slice that isolates what the vector channel and
   * the cross-encoder (#1158) are actually for.
   *
   * Overlap is computed under {@link generousTokens}, which splits underscores as
   * well as camelCase — deliberately NOT the production {@link tokenizeCode},
   * which does not. Using production's tokenizer would classify "membership of a
   * workspace" as keyword-free against `workspace_members`, because that tokenizer
   * emits `workspace_members` as ONE term. That is the exact defect #1159 fixes,
   * so the stratum would silently re-partition itself the moment #1159 landed and
   * the before/after comparison it exists to support would be comparing two
   * different sets of queries.
   */
  keywordFree: boolean;
}

/** One hand-authored NL requirement and the symbol(s) that implement it. */
export interface EmbedRetrievalQuerySpec {
  id: string;
  /** The natural-language requirement, in requirement register. */
  requirement: string;
  /** Target symbols, by `name` + `filePath` (resolved to symbol ids at load). */
  relevant: Array<{ name: string; filePath: string }>;
  /** Optional note recording how the ground truth was decided. */
  note?: string;
  /**
   * The declared strata. Optional because `embedretrieval-01` predates them and
   * must keep loading unchanged; `null` on a resolved query means "this query is
   * in no stratum", and per-stratum reporting states that denominator rather
   * than quietly folding it into a bucket.
   */
  strata?: QueryStrata;
}

/** Descriptor committed alongside the snapshot (`queries.json`). */
export interface EmbedRetrievalCorpusSpec {
  id: string;
  title: string;
  /** Provenance of the snapshot — repo commit the files were copied from. */
  snapshotCommit: string;
  groundTruth: string;
  /** Prose describing the declared strata and how they were derived (#1157). */
  strata?: string;
  queries: EmbedRetrievalQuerySpec[];
}

/** A corpus document: one code symbol, with the text production would embed. */
export interface CorpusDoc {
  id: string;
  filePath: string;
  name: string;
  kind: string;
  /** `formatSymbolForEmbedding` output — the production index-time text. */
  text: string;
}

/** A resolved query: requirement text + the relevant symbol ids. */
export interface CorpusQuery {
  id: string;
  requirement: string;
  relevant: string[];
  /** The declared strata, or `null` for a corpus that declares none. */
  strata: QueryStrata | null;
}

export interface EmbedRetrievalCorpus {
  spec: EmbedRetrievalCorpusSpec;
  projectId: string;
  symbols: EvalCodeSymbol[];
  docs: CorpusDoc[];
  queries: CorpusQuery[];
  /**
   * BM25-indexable view of EVERY symbol, schema symbols included — production's
   * lexical index has no `kind` filter. A superset of {@link EmbedRetrievalCorpus.docs};
   * see this module's header for why the two differ.
   */
  searchable: SearchableSymbol[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of `eval-data/corpus/`. */
function corpusRoot(): string {
  return path.resolve(__dirname, "..", "..", "..", "..", "..", "eval-data", "corpus");
}

/**
 * Resolve a corpus id to its committed directory.
 *
 * The id is CONTAINED to `eval-data/corpus/` rather than trusted: it reaches this
 * function from `--corpus` on the CLI, so a `../../` id would otherwise read
 * `queries.json` from anywhere on disk. Rejecting the traversal is cheaper than
 * reasoning about who can pass the flag.
 *
 * Two containment details that are easy to get subtly wrong (PR #1174 review):
 *
 *  1. An id that resolves to the ROOT ITSELF (`""`, `"."`, `"a/.."`) is rejected
 *     here rather than returned. `eval-data/corpus/` is a directory of corpora,
 *     not a corpus; returning it turned `--corpus ""` into a confusing `ENOENT`
 *     on `<root>/queries.json` several frames later instead of naming the bad id.
 *  2. Containment is re-checked after `realpath`, so a symlink inside
 *     `eval-data/corpus/` cannot point out of it. The lexical `path.resolve`
 *     check alone is blind to symlinks. A corpus id that does not exist yet is
 *     left to the lexical check, because there is no link to follow.
 */
export function corpusDir(id: string = DEFAULT_CORPUS_ID): string {
  const root = corpusRoot();
  const resolved = path.resolve(root, id);
  if (resolved === root) {
    throw new Error(
      `Corpus id "${id}" resolves to eval-data/corpus/ itself, which is the directory ` +
        `of corpora rather than a corpus. Pass a corpus id, e.g. "${DEFAULT_CORPUS_ID}".`,
    );
  }
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Corpus id "${id}" resolves outside eval-data/corpus/`);
  }
  // Symlink containment. `realpathSync` throws ENOENT for an id that has not been
  // created, and that case is already contained by the lexical check above.
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    return resolved;
  }
  const realRoot = realpathSync(root);
  if (!real.startsWith(realRoot + path.sep)) {
    throw new Error(`Corpus id "${id}" resolves outside eval-data/corpus/ through a symlink`);
  }
  return resolved;
}

/**
 * Default absolute directory of the committed corpus.
 *
 * This is `embedretrieval-02` as of #1157. `embedretrieval-01` stays addressable
 * through {@link corpusDir} — the committed `eval-results/*.md` cite it by name and
 * `snapshotCommit`, and a silently redirected id would make those files lie.
 */
export function defaultCorpusDir(): string {
  return corpusDir(DEFAULT_CORPUS_ID);
}

async function readRepoFiles(
  repoDir: string,
): Promise<Array<{ relPath: string; content: string }>> {
  const files: Array<{ relPath: string; content: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const relPath = path.relative(repoDir, abs).split(path.sep).join("/");
        files.push({ relPath, content: await fs.readFile(abs, "utf8") });
      }
    }
  };
  await walk(repoDir);
  return files;
}

/**
 * Build the production index-time text for a parsed symbol: the symbol header
 * plus the first lines of its body, sliced out of the source file. Pure.
 */
export function buildDocText(symbol: EvalCodeSymbol, fileContent: string): string {
  const lines = fileContent.split("\n");
  const bodyLines = lines.slice(symbol.startLine - 1, symbol.endLine);
  const forEmbedding: SymbolForEmbedding = {
    symbolId: symbol.id,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind as SymbolKind,
    filePath: symbol.filePath,
    bodyLines,
  };
  return formatSymbolForEmbedding(forEmbedding);
}

/**
 * Materialise SQL `table` / `column` symbols from ORM sources, through the
 * PRODUCTION extractor and the PRODUCTION qualified-name functions.
 *
 * `extractOrm` is the same pure function `persistOrmFile` calls during ingest, and
 * `tableQualifiedName` / `columnQualifiedName` are the same identity functions
 * `SchemaGraphWriter.ensureTable` / `.ensureColumn` use — so a corpus SQL symbol
 * carries the name, qualifiedName, `kind` and `language: "sql"` production would
 * have written for the same file. Nothing here re-implements the mapping.
 *
 * Symbols are deduplicated by qualifiedName, mirroring the writer's own table and
 * column caches: two models mapped onto one table are one symbol in production,
 * and would otherwise be two distractors that production does not have.
 */
export function buildSchemaSymbolsFromOrm(
  files: ReadonlyArray<{ relPath: string; content: string }>,
  projectId: string,
): EvalCodeSymbol[] {
  const byQualifiedName = new Map<string, EvalCodeSymbol>();
  const add = (
    kind: "table" | "column",
    name: string,
    qualifiedName: string,
    relPath: string,
    line: number,
  ): void => {
    if (byQualifiedName.has(qualifiedName)) return;
    byQualifiedName.set(qualifiedName, {
      id: `${relPath}::${qualifiedName}`,
      projectId,
      kind,
      name,
      qualifiedName,
      filePath: relPath,
      startLine: line,
      endLine: line,
      language: "sql",
    });
  };

  for (const { relPath, content } of files) {
    for (const entity of extractOrm(relPath, content)) {
      const tableQn = tableQualifiedName(entity.schema, entity.table);
      add("table", tableQn, tableQn, relPath, entity.line);
      for (const field of entity.fields) {
        const columnQn = columnQualifiedName(entity.schema, entity.table, field.column);
        add("column", field.column.toLowerCase(), columnQn, relPath, entity.line);
      }
    }
  }
  return [...byQualifiedName.values()];
}

/**
 * Tokenize for the OVERLAP question — production's {@link tokenizeCode} plus an
 * underscore split.
 *
 * This is the one place in the harness that deliberately does not mirror the
 * production tokenizer, and the reason is in {@link QueryStrata.keywordFree}: a
 * stratum defined by a tokenizer that a sub-issue is about to change is a stratum
 * that re-partitions itself mid-experiment. `generousTokens` answers "does a human
 * see a shared word here", which #1159 does not move.
 */
export function generousTokens(text: string): string[] {
  return tokenizeCode(text.replace(/_/g, " "));
}

/**
 * Derive a query's strata from the requirement text and its resolved targets.
 *
 * Deriving rather than declaring is the point. `keywordFree` is a claim about what
 * a lexical channel can and cannot see, and it is checkable: BM25 sees exactly
 * `name + " " + qualifiedName` (`BM25Index.buildDocumentText`). An editorial
 * "this one feels keyword-free" is unfalsifiable and rots silently the moment a
 * symbol is renamed; this cannot, and `corpus.test.ts` fails when a committed
 * declaration and this function disagree.
 *
 * A multi-target query is `keywordFree` only when EVERY target is lexically
 * unreachable. One reachable target is enough for BM25 to score the query, so the
 * `some`/`every` choice here is the difference between a stratum that means
 * "unreachable" and one that means "partly reachable".
 */
export function deriveStrata(
  requirement: string,
  targets: readonly Pick<EvalCodeSymbol, "name" | "qualifiedName">[],
): QueryStrata {
  const queryTokens = new Set(generousTokens(requirement));
  const naming = targets.some((t) => t.name.includes("_")) ? "snake" : "camel";
  const keywordFree = targets.every(
    (t) => !generousTokens(`${t.name} ${t.qualifiedName}`).some((tok) => queryTokens.has(tok)),
  );
  return { naming, keywordFree };
}

/**
 * Resolve a query spec's `{name, filePath}` targets to parsed symbol ids.
 * Throws when a target does not exist in the snapshot — a stale ground-truth
 * label must fail loudly rather than silently score as an unreachable miss.
 */
export function resolveQuery(
  spec: EmbedRetrievalQuerySpec,
  symbols: readonly EvalCodeSymbol[],
): CorpusQuery {
  const relevant = spec.relevant.map((target) => {
    const match = symbols.find((s) => s.name === target.name && s.filePath === target.filePath);
    if (!match) {
      throw new Error(
        `Corpus query "${spec.id}" references a symbol that is not in the snapshot: ` +
          `${target.name} in ${target.filePath}`,
      );
    }
    return match.id;
  });
  if (relevant.length === 0) {
    throw new Error(`Corpus query "${spec.id}" has no relevant symbols`);
  }
  return {
    id: spec.id,
    requirement: spec.requirement,
    relevant,
    strata: spec.strata ?? null,
  };
}

/** Load, parse, and resolve the committed corpus. No network, no DB. */
export async function loadEmbedRetrievalCorpus(
  dir = defaultCorpusDir(),
): Promise<EmbedRetrievalCorpus> {
  const spec = JSON.parse(
    await fs.readFile(path.join(dir, "queries.json"), "utf8"),
  ) as EmbedRetrievalCorpusSpec;

  const files = await readRepoFiles(path.join(dir, "repo"));
  const byPath = new Map(files.map((f) => [f.relPath, f.content]));
  const codeSymbols = buildSymbolsFromRepo(files, EMBED_RETRIEVAL_PROJECT_ID);

  // `schema/` is optional: `embedretrieval-01` has none, and its symbol set,
  // doc set and searchable set must come out byte-identical to before #1157.
  // Only ABSENCE is tolerated — a schema dir that exists but cannot be read is a
  // corpus that would silently score without its SQL stratum.
  const schemaDir = path.join(dir, "schema");
  const hasSchema = await fs
    .stat(schemaDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  const schemaFiles = hasSchema ? await readRepoFiles(schemaDir) : [];
  const schemaSymbols = buildSchemaSymbolsFromOrm(schemaFiles, EMBED_RETRIEVAL_PROJECT_ID);
  const symbols = [...codeSymbols, ...schemaSymbols];

  // Only PARSED-FILE symbols get an embedding row in production, so only they
  // become docs. See this module's header.
  const docs: CorpusDoc[] = codeSymbols.map((s) => ({
    id: s.id,
    filePath: s.filePath,
    name: s.name,
    kind: s.kind,
    text: buildDocText(s, byPath.get(s.filePath) ?? ""),
  }));

  // Exactly the fields production's `SYMBOL_SELECT` can supply, plus `language`
  // (a real `CodeSymbol` column, added for #1159's lever-2 arm). `signature` and
  // `docstring` are deliberately ABSENT: `CodeSymbol` has no such columns, so a
  // corpus that populated them would let the harness measure a BM25 document
  // production cannot build. `assertProductionReachableFields` (`lexical-ab.ts`)
  // fails the run if that ever changes.
  const searchable: SearchableSymbol[] = symbols.map((s) => ({
    symbolId: s.id,
    name: s.name,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    filePath: s.filePath,
    language: s.language,
  }));

  const queries = spec.queries.map((q) => resolveQuery(q, symbols));

  return { spec, projectId: EMBED_RETRIEVAL_PROJECT_ID, symbols, docs, queries, searchable };
}
