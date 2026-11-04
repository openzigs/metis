/**
 * #1036 — seed a change into code with the chat path's hybrid search, and split
 * what comes back into EDIT CANDIDATES and the wider set to REVIEW.
 *
 * Before this, every fragment of a request was mapped by names-only BM25
 * (`mapRequirementToCode`): ten symbols per fragment, each a seed for a two-hop
 * caller walk. On the six Miniflux developer issues of walkthrough run 7 that
 * named 57 to 115 files per issue, 1 to 3% of them right. The chat path, asked
 * the same questions on the same model, was right 25 to 55% of the time — it
 * searches with `HybridCodeSearch` (BM25 fused with symbol embeddings), which is
 * the searcher this module is given.
 *
 * A symbol-level ranking is the wrong unit for "which files do I edit": one
 * relevant file usually holds several middling hits, and a 100-function file
 * holds a lot of unrelated ones. So hits are ranked by FILE:
 *
 *   file score = Σ hitᵢ × {@link FILE_HIT_DECAY}ⁱ   (the file's hits, best first)
 *
 * Agreement between hits lifts a file; sheer size does not (the fifth hit of a
 * big file is worth a sixteenth of its first). The top
 * {@link MAX_EDIT_FILES} files within {@link MIN_FILE_SHARE} of the best are the
 * edit candidates. Everything else retrieved is returned as `related`: listed
 * for review, never claimed to change.
 *
 * PROVISIONAL CONSTANTS. Every cut size below was chosen on the six Miniflux
 * issues of walkthrough run 7, and the before/after in docs/ARCHITECTURE.md
 * ("Edit candidates vs blast radius") is measured on those same six: it is an
 * in-sample number, not a held-out one. They were deliberately not tuned
 * further — with six issues the differences between nearby settings (sum vs
 * decay, four files vs five) are noise — and they are to be REVISITED AT RUN 8.
 * The one out-of-sample reading there is, the five-case TypeScript `reqmap`
 * fixture run offline through this seeding, is recorded in the same section.
 * A known cost: {@link MAX_EDIT_FILES} caps edit-candidate recall on any change
 * that touches more files than it (#4511 edits six and is found at 17%).
 *
 * #1754 — STORED LINKS. For a change about a tracked requirement, the
 * requirement's stored code links (`RequirementCodeMapping`, written by the
 * Analysis code agent, the hybrid mapper and people) are a second channel,
 * behind `IMPACT_STORED_LINK_SEEDS` (off by default). They are UNIONED after
 * the hybrid edit candidates, never in place of them: no hybrid seed is
 * dropped, moved or re-scored (the #931 rule). Only a link whose file is in the
 * project's current code graph is seeded; a stale one is dropped and counted.
 *
 * #1776 — PER-REQUEST RANKING. The cut above runs once per change per
 * project, so every project names its own best file and a request the
 * extractor splits gets {@link MAX_EDIT_FILES} files per change. Behind
 * `IMPACT_REQUEST_EDIT_RANKING` (off by default),
 * {@link rankEditCandidatesPerRequest} re-applies the same cut ONCE, over
 * every change and project of the request, against its single best file. A
 * file that falls out is moved to `related` and stays a seed of the blast
 * radius (`radiusSeeds`), so recall of affected code does not drop.
 *
 * Read-only, and never throws: a search fault yields no seeds.
 */
import type { PrismaClient } from "@prisma/client";
import type { ImpactSeedChannel, ImpactSeedEvidence } from "@metis/shared";
import { getConfigService } from "../config/config-service.js";
import { isDocumentationFilePath, isTestFilePath } from "../analysis/traceability-matrix.js";
import { createChildLogger } from "../logger.js";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";
import { isHttpHandlerSignature } from "../spec-kit/page-handlers.js";
import { requestRetrievalText } from "./change-request.js";
import type { ChangedRequirement } from "./extract-changes.js";

const log = createChildLogger("impact-change-seeds");

/** How one seeding searched. See `RetrievalMode` in `hybrid-search.ts`. */
export type RetrievalMode = "hybrid" | "bm25-only";

/** One ranked hit, as the fused code searcher returns it. */
export interface SeedSearchHit {
  symbolId: string;
  filePath: string;
  name: string;
  kind: string;
  score: number;
}

/** The search this module seeds with. `FusedCodeSearcher` satisfies it. */
export interface SeedSearcher {
  search(
    query: string,
    projectId: string,
    opts?: { limit?: number; onRetrievalMode?: (mode: RetrievalMode) => void },
  ): Promise<SeedSearchHit[]>;
}

/** What the search result does not carry: the qualified name and the lines. */
export interface SeedSymbolRow {
  id: string;
  qualifiedName: string;
  filePath: string;
  kind: string;
  language: string;
  startLine: number | null;
  endLine: number | null;
  /** #1135 — the stored declaration, to tell an HTTP handler. Absent from older loaders. */
  signature?: string | null;
}

export type SeedSymbolLoader = (symbolIds: string[], projectId: string) => Promise<SeedSymbolRow[]>;

export interface ChangeSeedDeps {
  searcher: SeedSearcher;
  loadSymbols: SeedSymbolLoader;
  /**
   * #1135 — which of the given symbols write a table (lineage `writes` /
   * `persists-to`). Absent: no symbol is treated as a writer.
   */
  loadWriterIds?: (symbolIds: string[], projectId: string) => Promise<Set<string>>;
  /**
   * #1754 — the stored-link channel. Absent (the flag off): the seeds are
   * exactly the hybrid ones, with no evidence attached.
   */
  storedLinks?: StoredLinkDeps;
  /**
   * #1756 — when set, also return the hybrid FILE pool (`filePool`): this many
   * files at most, for the LLM edit-candidate check. Absent: no pool, and the
   * seeds are exactly as before.
   */
  filePoolSize?: number;
  /**
   * #1776 — when true, also return each hybrid edit file's score
   * (`editFileScores`), for {@link rankEditCandidatesPerRequest}. Absent: the
   * seeds are exactly as before.
   */
  editFileScores?: boolean;
}

/** #1756 — files of the hybrid pool shown to the edit-candidate check, by default. */
export const VERIFY_POOL_FILES = 30;

/** #1756 — one symbol of a pool file, with the score the hybrid search gave it. */
export interface SeedPoolSymbol {
  codeSymbolId: string;
  qualifiedName: string;
  kind: string;
  startLine: number | null;
  endLine: number | null;
  signature: string | null;
  /** The hit's score over the best hit's: the confidence an edit candidate would carry. */
  confidence: number;
}

/**
 * #1756 — one FILE of the hybrid candidate pool. `EDIT_POOL` counts symbols;
 * the pool rolls the production hits up to files and ranks them by
 * {@link fileScore}, the deterministic edit candidates first.
 */
export interface SeedPoolFile {
  filePath: string;
  /** The file's {@link fileScore}: its deterministic base score. */
  score: number;
  /** True for a file the deterministic ranking already made an edit candidate. */
  editCandidate: boolean;
  /** The file's best hits, named symbols before its module, at most {@link MAX_SYMBOLS_PER_EDIT_FILE}. */
  symbols: SeedPoolSymbol[];
}

/** #1754 — one stored requirement-to-code link (`RequirementCodeMapping`). */
export interface StoredLinkRow {
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  confidence: number;
  /** `manual` (a person confirmed it) or `semantic` (written by a mapper or the code agent). */
  source: string;
}

export interface StoredLinkDeps {
  /** A requirement's links IN ONE PROJECT: filtered on both columns. */
  loadLinks: (requirementId: string, projectId: string) => Promise<StoredLinkRow[]>;
  /** The project's code-graph symbols in the given files: none for a file the graph lost. */
  loadFileSymbols: (filePaths: string[], projectId: string) => Promise<SeedSymbolRow[]>;
}

/** The env/runtime flag for per-request edit-candidate ranking. Off by default (#1776). */
export const REQUEST_EDIT_RANKING_FLAG = "IMPACT_REQUEST_EDIT_RANKING";

/** #1776 — whether edit candidates are ranked once per request. Off until a held-out gain is shown. */
export function impactRequestEditRankingEnabled(): boolean {
  return getConfigService().getBool(REQUEST_EDIT_RANKING_FLAG, false);
}

/** The env/runtime flag for the stored-link channel. Off by default (#1754). */
export const STORED_LINK_SEEDS_FLAG = "IMPACT_STORED_LINK_SEEDS";

/** #1754 — whether the stored-link channel runs. Off until a held-out gain is shown. */
export function impactStoredLinkSeedsEnabled(): boolean {
  return getConfigService().getBool(STORED_LINK_SEEDS_FLAG, false);
}

export interface ChangeSeeds {
  /** Symbols in the files the change probably edits. Small. */
  editCandidates: RequirementCodeMatch[];
  /** Everything else retrieved: for review, and for recall. */
  related: RequirementCodeMatch[];
  /**
   * Tables and columns among the very best hits. Not code, so never an edit
   * candidate — issue #1036 names `users.reading_speed` under "Directly affected"
   * as noise — but still how a request that names a column reaches its table: the
   * engine crosses into the schema from these, as it did from a mapper-seeded
   * column, and lists them for review.
   */
  schemaSeeds: RequirementCodeMatch[];
  /**
   * `bm25-only` when ANY query of this seeding ran without the vector channel
   * (symbols not embedded yet, or a vector fault), `hybrid` when every query had
   * it, null when the searcher did not say. Absent on hand-built seeds.
   */
  retrievalMode?: RetrievalMode | null;
  /**
   * #1754 — how the change was seeded, set only when a channel beyond the
   * hybrid one ran (the stored-link channel, for a change with a
   * `requirementId`). Absent otherwise.
   */
  evidence?: ImpactSeedEvidence;
  /** #1756 — the hybrid file pool, when `filePoolSize` asked for it. */
  filePool?: SeedPoolFile[];
  /**
   * #1776 — the hybrid edit files with their {@link fileScore}, best first, when
   * `editFileScores` asked for them. The per-request ranking reads these.
   */
  editFileScores?: EditFileScore[];
  /**
   * #1776 — edit candidates the per-request ranking moved to `related`. Not
   * files to edit, but still seeds of the blast radius, so the callers the
   * per-change seeding reached are still reached.
   */
  radiusSeeds?: RequirementCodeMatch[];
}

/** #1776 — one file's score in the edit-candidate ranking. */
export interface EditFileScore {
  filePath: string;
  score: number;
}

// PROVISIONAL — tuned in-sample on six Miniflux issues; revisit at run 8 (see
// the module header).

/** Hits requested per query. */
export const SEED_POOL_PER_QUERY = 120;
/** Fused production-code hits the file ranking reads. */
export const EDIT_POOL = 60;
/** Files named as edit candidates, at most. */
export const MAX_EDIT_FILES = 5;
/** A file scoring under this share of the best file is not an edit candidate. */
export const MIN_FILE_SHARE = 0.5;
/** Weight of a file's i-th best hit relative to the one before it. */
export const FILE_HIT_DECAY = 0.5;
/** Symbols listed per edit-candidate file. */
export const MAX_SYMBOLS_PER_EDIT_FILE = 4;
/** `related` symbols returned, at most. */
export const MAX_RELATED = 100;
/** How far down the fused ranking a table or column still seeds the schema crossing. */
export const SCHEMA_SEED_TOP = 10;
/** A `related` hit is one step out: its confidence is scaled by this. */
export const RELATED_CONFIDENCE_FACTOR = 0.6;

/**
 * #1135 — on a read-path bug, an HTTP handler hit counts this many times over
 * in the file ranking: the handler builds the response that is wrong.
 */
export const READ_PATH_HANDLER_BOOST = 2;

/**
 * Words that say a request changes stored data. A bug report with none of them
 * is a READ-PATH bug: something is shown or returned wrong.
 */
const STORED_DATA_CHANGE_RE =
  /\b(?:migrations?|schema|new (?:column|field|table)s?|add(?:s|ing)? (?:a |an |the )?(?:new )?(?:column|field|table)s?|persist(?:s|ed|ing)?|stor(?:e|es|ed|ing) (?:a |an |the )?new|timestamp column)\b/i;

/** A verb that changes stored data, in any of its inflections. */
const WRITE_VERB =
  "(?:(?:sav|updat|stor|delet|remov|creat|archiv)(?:e|es|ed|ing)?|writ(?:e|es|ten|ing)|wrote" +
  "|(?:insert|persist|mark|add|edit|import)(?:s|ed|ing)?|modif(?:y|ies|ied|ying))";
/** A negation in front of the verb: "not", "never", "isn't", "don't", "won't", "fails to"… */
const WRITE_NEGATION =
  "(?:not|never|cannot|unable\\s+to|fail(?:s|ed)?\\s+to" +
  "|(?:is|are|was|were|has|have|had|does|do|did|wo|ca|could|would|should)n['\u2019]?t)";
/** What a failed write does: "fails", "throws", "errors", "does nothing", "has no effect"… */
const WRITE_FAILURE =
  "(?:fail(?:s|ed|ing)?|throw(?:s|n|ing)?|error(?:s|ed)?|crash(?:es|ed|ing)?" +
  "|(?:does|did) nothing|(?:has|had) no effect|(?:does|did)(?: not|n['\u2019]?t) work|is ignored)";

/**
 * Words that say the bug is a failed WRITE: a negated write verb ("not saved",
 * "isn't saved", "don't get updated", "won't delete", "never written to the
 * database"), a write verb followed by a failure ("deleting a feed throws",
 * "Mark all as read does nothing", "delete fails"), or a row left behind
 * ("leaves entries in the table"). The writer is then the fix site and must
 * stay an edit candidate. Erring this way is the safe side: a missed read-path
 * bug only keeps a writer in the files to edit, as before #1135.
 */
const WRITE_PATH_RE = new RegExp(
  `\\b(?:${WRITE_NEGATION}\\s+(?:(?:be|been|get|gets|got|gotten|getting)\\s+)?${WRITE_VERB}` +
    `|${WRITE_VERB}\\b[^.\\n]{0,40}\\b${WRITE_FAILURE}` +
    `|written to|leaves?\\b[^.\\n]{0,60}\\bin the (?:table|database|db))\\b`,
  "i",
);

/**
 * #1135 — true for a bug report that changes no stored data. For one, the
 * functions that WRITE a table are not files to edit by default: in #706 run 8
 * the impact for Miniflux #4386 ("0 entries after 'Mark this page as read'")
 * named the storage status writers, which the fix must not touch, and left the
 * page handlers that build the empty page under Related.
 */
export function isReadPathBug(
  change: Pick<ChangedRequirement, "title" | "body" | "request">,
): boolean {
  if (change.request?.kind !== "bug") return false;
  const text = `${change.title}\n${change.body}`.slice(0, MAX_SEED_QUERY_CHARS * 4);
  return !STORED_DATA_CHANGE_RE.test(text) && !WRITE_PATH_RE.test(text);
}

const SCHEMA_KINDS: ReadonlySet<string> = new Set(["table", "column", "procedure"]);

/**
 * True for a symbol that is DATA, not code: a table, a column, or a stored
 * routine. Decided by KIND. Language is not evidence: a MyBatis mapper statement
 * is stored as kind `method`, language `sql`, in its mapper XML
 * (`createOriginSymbol`), and that XML file is code a change edits — reading
 * every `sql` symbol as schema took mapper files out of the edit candidates
 * (PR #1090 panel). The one kind that needs the language is `function`, which a
 * stored SQL function shares with ordinary code.
 */
export function isSchemaSymbol(row: Pick<SeedSymbolRow, "kind" | "language">): boolean {
  return SCHEMA_KINDS.has(row.kind) || (row.kind === "function" && row.language === "sql");
}

/**
 * Longest query handed to the code search. A request is accepted up to 500,000
 * characters and the search tokenizes its whole query; retrieval gains nothing
 * past the first few thousand (the six run-7 issues are 0.6 to 1.7 KB), and an
 * uncapped query was the one route by which request text reached the search's
 * tokenizer at full length (PR #1090 review 2).
 */
export const MAX_SEED_QUERY_CHARS = 4000;

/**
 * `text` cut to {@link MAX_SEED_QUERY_CHARS}: at the last whitespace when that
 * costs under 100 characters (so no word is halved), by length otherwise.
 */
function capQuery(text: string): string {
  if (text.length <= MAX_SEED_QUERY_CHARS) return text;
  const head = text.slice(0, MAX_SEED_QUERY_CHARS);
  const lastBreak = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  return lastBreak >= MAX_SEED_QUERY_CHARS - 100 ? head.slice(0, lastBreak).trimEnd() : head;
}

/**
 * The queries a change is searched with: its title (short and specific), and the
 * whole request. For an issue the second is {@link requestRetrievalText}, which
 * leaves out rejected alternatives, code fences and links. Each is capped at
 * {@link MAX_SEED_QUERY_CHARS} — and the request is cut down BEFORE the link,
 * URL and whitespace replaces, not after: `requestRetrievalText` is told the
 * cap, so of a 500,000 character request only one linear fence pass reads more
 * than 16,000 characters of a section (PR #1090 review 3).
 */
export function seedQueries(
  change: Pick<ChangedRequirement, "title" | "body" | "request">,
): string[] {
  const whole = change.request
    ? requestRetrievalText(change.request, { maxChars: MAX_SEED_QUERY_CHARS })
    : `${change.title}\n\n${change.body}`.trim();
  const queries = [change.title.trim(), whole].map(capQuery).filter((q) => q.length > 0);
  return [...new Set(queries)];
}

/** `Σ hitᵢ × decayⁱ` over a file's hit scores, best first. */
export function fileScore(scores: readonly number[]): number {
  return [...scores]
    .sort((a, b) => b - a)
    .reduce((sum, score, i) => sum + score * Math.pow(FILE_HIT_DECAY, i), 0);
}

/** The files to edit: the best {@link MAX_EDIT_FILES}, each close enough to the best. */
export function rankEditFiles(hits: ReadonlyArray<{ filePath: string; score: number }>): string[] {
  return rankEditFileScores(hits).map((f) => f.filePath);
}

/** {@link rankEditFiles}, with each file's {@link fileScore}. */
export function rankEditFileScores(
  hits: ReadonlyArray<{ filePath: string; score: number }>,
): EditFileScore[] {
  const byFile = new Map<string, number[]>();
  for (const h of hits) byFile.set(h.filePath, [...(byFile.get(h.filePath) ?? []), h.score]);
  return cutEditFiles(
    [...byFile.entries()]
      .map(([filePath, scores]) => ({ filePath, score: fileScore(scores) }))
      .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath)),
  );
}

/** The edit-file cut over files ranked best first: the top {@link MAX_EDIT_FILES} within {@link MIN_FILE_SHARE} of the best. */
function cutEditFiles<T extends { score: number }>(ranked: readonly T[]): T[] {
  const best = ranked[0]?.score ?? 0;
  if (best <= 0) return [];
  return ranked.filter((f) => f.score >= best * MIN_FILE_SHARE).slice(0, MAX_EDIT_FILES);
}

/** #1776 — one seeding of a request: a change, seeded in one project. */
export interface RequestSeeding {
  projectId: string;
  seeds: ChangeSeeds;
}

/** #1776 — an edit file the per-request ranking kept. */
export interface RequestEditFile extends EditFileScore {
  projectId: string;
}

const requestFileKey = (projectId: string, filePath: string) =>
  JSON.stringify([projectId, filePath]);

/**
 * #1776 — the request's edit files: every seeding's hybrid edit files (a file
 * found by several changes counts once, at its best score), cut ONCE against
 * the request's best file by the same rule as {@link rankEditFiles}. Seeds
 * without `editFileScores` contribute nothing.
 */
export function rankRequestEditFiles(seedings: readonly RequestSeeding[]): RequestEditFile[] {
  const best = new Map<string, RequestEditFile>();
  for (const { projectId, seeds } of seedings) {
    for (const f of seeds.editFileScores ?? []) {
      const key = requestFileKey(projectId, f.filePath);
      const prev = best.get(key);
      if (!prev || f.score > prev.score) best.set(key, { projectId, ...f });
    }
  }
  return cutEditFiles(
    [...best.values()].sort(
      (a, b) =>
        b.score - a.score ||
        a.projectId.localeCompare(b.projectId) ||
        a.filePath.localeCompare(b.filePath),
    ),
  );
}

/**
 * #1776 — rank edit candidates once per request, across every change and
 * project, instead of once per seeding. A hybrid edit file outside
 * {@link rankRequestEditFiles} leaves `editCandidates`: its symbols head
 * `related` (at the related scale) and become `radiusSeeds`, so the blast
 * radius is walked from them as before. A file a stored link names stays (the
 * #1754 channel never loses a candidate here), and so does any candidate
 * without a hybrid score. Returns the seeds in the input order; a seeding that
 * loses nothing comes back as the same object.
 */
export function rankEditCandidatesPerRequest(seedings: readonly RequestSeeding[]): ChangeSeeds[] {
  const kept = new Set(
    rankRequestEditFiles(seedings).map((f) => requestFileKey(f.projectId, f.filePath)),
  );
  return seedings.map(({ projectId, seeds }) => {
    const linked = new Set(
      (seeds.evidence?.editCandidates ?? [])
        .filter((e) => e.channels.includes("stored-link"))
        .map((e) => e.filePath),
    );
    const dropped = new Set(
      (seeds.editFileScores ?? [])
        .map((f) => f.filePath)
        .filter((f) => !kept.has(requestFileKey(projectId, f)) && !linked.has(f)),
    );
    const demoted = seeds.editCandidates.filter((m) => dropped.has(m.filePath));
    if (demoted.length === 0) return seeds;
    return {
      ...seeds,
      editCandidates: seeds.editCandidates.filter((m) => !dropped.has(m.filePath)),
      related: [
        ...demoted.map((m) => ({ ...m, confidence: m.confidence * RELATED_CONFIDENCE_FACTOR })),
        ...seeds.related,
      ],
      radiusSeeds: [...(seeds.radiusSeeds ?? []), ...demoted],
      ...(seeds.filePool
        ? {
            filePool: seeds.filePool.map((f) =>
              dropped.has(f.filePath) ? { ...f, editCandidate: false } : f,
            ),
          }
        : {}),
      ...(seeds.evidence
        ? {
            evidence: {
              ...seeds.evidence,
              editCandidates: seeds.evidence.editCandidates.filter((e) => !dropped.has(e.filePath)),
            },
          }
        : {}),
    };
  });
}

interface FusedHit extends SeedSearchHit {
  row: SeedSymbolRow;
}

function toMatch(hit: FusedHit, confidence: number): RequirementCodeMatch {
  return {
    codeSymbolId: hit.symbolId,
    filePath: hit.row.filePath,
    qualifiedName: hit.row.qualifiedName,
    startLine: hit.row.startLine,
    endLine: hit.row.endLine,
    confidence: Math.min(1, Math.max(0, confidence)),
  };
}

/**
 * Search for `change` and split the result. Returns three empty lists when the
 * project has no code graph, the search fails, or nothing matches.
 */
export async function resolveChangeSeeds(
  change: Pick<ChangedRequirement, "title" | "body" | "request"> &
    Partial<Pick<ChangedRequirement, "requirementId">>,
  projectId: string,
  deps: ChangeSeedDeps,
): Promise<ChangeSeeds> {
  const hybrid = await resolveHybridSeeds(change, projectId, deps);
  if (!deps.storedLinks || !change.requirementId) return hybrid;
  const seeds = await unionStoredLinks(hybrid, change.requirementId, projectId, deps.storedLinks);
  if (!seeds.filePool) return seeds;
  // #1781 — the pool marks every edit candidate [EDIT], stored-link ones too: an
  // unmarked one could be "promoted" (counted, nothing added) and never doubted.
  const editFiles = new Set(seeds.editCandidates.map((m) => m.filePath));
  return {
    ...seeds,
    filePool: seeds.filePool.map((f) =>
      !f.editCandidate && editFiles.has(f.filePath) ? { ...f, editCandidate: true } : f,
    ),
  };
}

/** The default channel: the fused hybrid search, split into edit candidates and the rest. */
async function resolveHybridSeeds(
  change: Pick<ChangedRequirement, "title" | "body" | "request">,
  projectId: string,
  deps: ChangeSeedDeps,
): Promise<ChangeSeeds> {
  const none: ChangeSeeds = { editCandidates: [], related: [], schemaSeeds: [] };
  const queries = seedQueries(change);
  if (queries.length === 0) return none;

  // A symbol found by both queries keeps both scores.
  const fused = new Map<string, SeedSearchHit>();
  const modes: RetrievalMode[] = [];
  try {
    for (const query of queries) {
      const hits = await deps.searcher.search(query, projectId, {
        limit: SEED_POOL_PER_QUERY,
        onRetrievalMode: (mode) => modes.push(mode),
      });
      for (const h of hits) {
        const prev = fused.get(h.symbolId);
        fused.set(h.symbolId, prev ? { ...prev, score: prev.score + h.score } : { ...h });
      }
    }
  } catch (err) {
    log.warn("seed search failed; no seeds", { projectId, error: String(err) });
    return none;
  }
  const retrievalMode: RetrievalMode | null =
    modes.length === 0 ? null : modes.includes("bm25-only") ? "bm25-only" : "hybrid";
  if (fused.size === 0) return { ...none, retrievalMode };

  let rows: SeedSymbolRow[];
  try {
    rows = await deps.loadSymbols([...fused.keys()], projectId);
  } catch (err) {
    log.warn("seed symbol lookup failed; no seeds", { projectId, error: String(err) });
    return none;
  }
  const rowById = new Map(rows.map((r) => [r.id, r]));
  // A hit whose symbol has gone (a re-ingest between search and lookup) is dropped.
  const ranked: FusedHit[] = [...fused.values()]
    .flatMap((h) => {
      const row = rowById.get(h.symbolId);
      return row ? [{ ...h, row }] : [];
    })
    .filter((h) => !isDocumentationFilePath(h.row.filePath))
    .sort((a, b) => b.score - a.score || a.row.qualifiedName.localeCompare(b.row.qualifiedName));
  if (ranked.length === 0) return none;

  // Only production code can be a file to edit: a test follows the change, and a
  // schema symbol is data, which the lineage stages handle.
  const isSchema = (h: FusedHit) => isSchemaSymbol(h.row);
  const production = ranked.filter((h) => !isTestFilePath(h.row.filePath) && !isSchema(h));
  // #1135 — a read-path bug: table writers stay for review, handlers count more.
  const readPath = isReadPathBug(change);
  let writers = new Set<string>();
  if (readPath && deps.loadWriterIds) {
    try {
      writers = await deps.loadWriterIds(
        production.slice(0, EDIT_POOL * 2).map((h) => h.symbolId),
        projectId,
      );
    } catch (err) {
      log.warn("writer lookup failed; writers stay edit candidates", {
        projectId,
        error: String(err),
      });
    }
  }
  const editable = production.filter((h) => !writers.has(h.symbolId)).slice(0, EDIT_POOL);
  const boost = (h: FusedHit) =>
    readPath && isHttpHandlerSignature(h.row.signature) ? READ_PATH_HANDLER_BOOST : 1;
  const editFileScores = rankEditFileScores(
    editable.map((h) => ({ filePath: h.row.filePath, score: h.score * boost(h) })),
  );
  const editFiles = new Set(editFileScores.map((f) => f.filePath));

  const top = ranked[0]!.score;
  const editCandidates: RequirementCodeMatch[] = [];
  const taken = new Set<string>();
  for (const filePath of editFiles) {
    const inFile = editable.filter((h) => h.row.filePath === filePath);
    // The file's own `module` symbol says nothing a named function does not.
    const named = inFile.filter((h) => h.row.kind !== "module");
    for (const h of (named.length > 0 ? named : inFile).slice(0, MAX_SYMBOLS_PER_EDIT_FILE)) {
      editCandidates.push(toMatch(h, h.score / top));
      taken.add(h.symbolId);
    }
  }

  const schemaSeeds = ranked
    .slice(0, SCHEMA_SEED_TOP)
    .filter(isSchema)
    .map((h) => toMatch(h, h.score / top));

  const related = ranked
    .filter((h) => !taken.has(h.symbolId) && !isSchema(h))
    // The rest of an edit file's hits add nothing to review that the file does not.
    .filter((h) => !editFiles.has(h.row.filePath))
    .slice(0, MAX_RELATED)
    .map((h) => toMatch(h, (h.score / top) * RELATED_CONFIDENCE_FACTOR));

  const seeds: ChangeSeeds = {
    editCandidates,
    related,
    schemaSeeds,
    retrievalMode,
    ...(deps.editFileScores ? { editFileScores } : {}),
  };
  if (!deps.filePoolSize) return seeds;
  const poolHits = production.filter((h) => !writers.has(h.symbolId));
  return { ...seeds, filePool: filePoolOf(poolHits, editFiles, deps.filePoolSize, top, boost) };
}

/**
 * #1756 — the production hits rolled up to files: the deterministic edit files
 * first, in their order, then the rest by {@link fileScore}, `size` at most.
 */
function filePoolOf(
  hits: readonly FusedHit[],
  editFiles: ReadonlySet<string>,
  size: number,
  top: number,
  boost: (h: FusedHit) => number,
): SeedPoolFile[] {
  const byFile = new Map<string, FusedHit[]>();
  for (const h of hits) byFile.set(h.row.filePath, [...(byFile.get(h.row.filePath) ?? []), h]);
  const scored = [...byFile.entries()].map(([filePath, inFile]) => ({
    filePath,
    inFile,
    score: fileScore(inFile.map((h) => h.score * boost(h))),
  }));
  const order = (a: { filePath: string; score: number }, b: { filePath: string; score: number }) =>
    b.score - a.score || a.filePath.localeCompare(b.filePath);
  const edit = [...editFiles].flatMap((f) => scored.filter((x) => x.filePath === f));
  const rest = scored.filter((x) => !editFiles.has(x.filePath)).sort(order);
  return [...edit, ...rest]
    .slice(0, Math.max(size, edit.length))
    .map(({ filePath, inFile, score }) => {
      const named = inFile.filter((h) => h.row.kind !== "module");
      return {
        filePath,
        score,
        editCandidate: editFiles.has(filePath),
        symbols: (named.length > 0 ? named : inFile)
          .slice(0, MAX_SYMBOLS_PER_EDIT_FILE)
          .map((h) => ({
            codeSymbolId: h.symbolId,
            qualifiedName: h.row.qualifiedName,
            kind: h.row.kind,
            startLine: h.row.startLine,
            endLine: h.row.endLine,
            signature: h.row.signature ?? null,
            confidence: Math.min(1, Math.max(0, h.score / top)),
          })),
      };
    });
}

/** A manual link ranks ahead of a semantic one; then the surer, then by path. */
function storedLinkOrder(a: StoredLinkRow, b: StoredLinkRow): number {
  const manual = (l: StoredLinkRow) => (l.source === "manual" ? 0 : 1);
  return (
    manual(a) - manual(b) || b.confidence - a.confidence || a.filePath.localeCompare(b.filePath)
  );
}

/** The symbols one link seeds: its own symbol, else the symbols on its lines, else the file's first few. */
function linkSymbols(link: StoredLinkRow, inFile: readonly SeedSymbolRow[]): SeedSymbolRow[] {
  const own = link.codeSymbolId ? inFile.find((r) => r.id === link.codeSymbolId) : undefined;
  if (own) return [own];
  const code = inFile.filter((r) => r.kind !== "module" && !isSchemaSymbol(r));
  const candidates = code.length > 0 ? code : inFile;
  if (link.startLine !== null && link.endLine !== null) {
    const { startLine: from, endLine: to } = link;
    const overlapping = candidates.filter(
      (r) => r.startLine !== null && r.endLine !== null && r.startLine <= to && r.endLine >= from,
    );
    if (overlapping.length > 0) return overlapping.slice(0, MAX_SYMBOLS_PER_EDIT_FILE);
  }
  return [...candidates]
    .sort((x, y) => (x.startLine ?? 0) - (y.startLine ?? 0))
    .slice(0, MAX_SYMBOLS_PER_EDIT_FILE);
}

/**
 * #1754 — add the requirement's stored links to the hybrid seeds. Each link
 * whose file is in the code graph becomes edit-candidate symbols, AFTER every
 * hybrid edit candidate (manual links first); a link to a file the graph no
 * longer holds is dropped and counted. The hybrid seeds come back as they
 * went in: the same objects, in the same order, with the same scores. Never
 * throws: a lookup fault keeps the hybrid seeds and records nothing used.
 */
export async function unionStoredLinks(
  hybrid: ChangeSeeds,
  requirementId: string,
  projectId: string,
  deps: StoredLinkDeps,
): Promise<ChangeSeeds> {
  let links: StoredLinkRow[];
  let fileRows: SeedSymbolRow[];
  try {
    links = await deps.loadLinks(requirementId, projectId);
    fileRows =
      links.length === 0
        ? []
        : await deps.loadFileSymbols([...new Set(links.map((l) => l.filePath))], projectId);
  } catch (err) {
    log.warn("stored-link lookup failed; hybrid seeds only", { projectId, error: String(err) });
    links = [];
    fileRows = [];
  }
  const byFile = new Map<string, SeedSymbolRow[]>();
  for (const r of fileRows) byFile.set(r.filePath, [...(byFile.get(r.filePath) ?? []), r]);

  const hybridFiles = new Set(hybrid.editCandidates.map((m) => m.filePath));
  const taken = new Set(hybrid.editCandidates.map((m) => m.codeSymbolId));
  const linkFiles = new Set<string>();
  const added: RequirementCodeMatch[] = [];
  let used = 0;
  let stale = 0;
  for (const link of [...links].sort(storedLinkOrder)) {
    const inFile = byFile.get(link.filePath);
    if (!inFile || inFile.length === 0) {
      stale++;
      continue;
    }
    used++;
    linkFiles.add(link.filePath);
    for (const row of linkSymbols(link, inFile)) {
      if (taken.has(row.id)) continue;
      taken.add(row.id);
      added.push({
        codeSymbolId: row.id,
        filePath: row.filePath,
        qualifiedName: row.qualifiedName,
        startLine: row.startLine,
        endLine: row.endLine,
        confidence: Math.min(1, Math.max(0, link.confidence)),
      });
    }
  }

  const editFiles = [...new Set([...hybrid.editCandidates, ...added].map((m) => m.filePath))];
  const channelsOf = (filePath: string): ImpactSeedChannel[] => [
    ...(hybridFiles.has(filePath) ? (["hybrid"] as const) : []),
    ...(linkFiles.has(filePath) ? (["stored-link"] as const) : []),
  ];
  return {
    ...hybrid,
    editCandidates: [...hybrid.editCandidates, ...added],
    evidence: {
      storedLinks: { used, stale },
      editCandidates: editFiles.map((filePath) => ({ filePath, channels: channelsOf(filePath) })),
    },
  };
}

/**
 * #1754 — the production stored-link lookups. Links are read for the
 * requirement AND the project (a link is project-scoped, and an id alone would
 * cross into another project's code); symbols for the project only.
 */
export function prismaStoredLinkDeps(
  prisma: Pick<PrismaClient, "codeSymbol" | "requirementCodeMapping">,
): StoredLinkDeps {
  return {
    loadLinks: (requirementId, projectId) =>
      prisma.requirementCodeMapping.findMany({
        where: { requirementId, projectId },
        select: {
          codeSymbolId: true,
          filePath: true,
          startLine: true,
          endLine: true,
          confidence: true,
          source: true,
        },
        orderBy: { id: "asc" },
      }),
    loadFileSymbols: prismaFileSymbolLoader(prisma),
  };
}

/** The project's code-graph symbols in the given files: project-scoped, chunked. */
export function prismaFileSymbolLoader(
  prisma: Pick<PrismaClient, "codeSymbol">,
): StoredLinkDeps["loadFileSymbols"] {
  const CHUNK = 500;
  return async (filePaths, projectId) => {
    const rows: SeedSymbolRow[] = [];
    for (let i = 0; i < filePaths.length; i += CHUNK) {
      rows.push(
        ...(await prisma.codeSymbol.findMany({
          where: { projectId, filePath: { in: filePaths.slice(i, i + CHUNK) } },
          select: SEED_SYMBOL_SELECT,
        })),
      );
    }
    return rows;
  };
}

const SEED_SYMBOL_SELECT = {
  id: true,
  qualifiedName: true,
  filePath: true,
  kind: true,
  language: true,
  startLine: true,
  endLine: true,
  signature: true,
} as const;

/** #1135 — the production writer lookup: lineage write edges, project-scoped, chunked. */
export function prismaWriterIdLoader(
  prisma: Pick<PrismaClient, "codeEdge">,
): (symbolIds: string[], projectId: string) => Promise<Set<string>> {
  const CHUNK = 500;
  return async (symbolIds, projectId) => {
    const out = new Set<string>();
    for (let i = 0; i < symbolIds.length; i += CHUNK) {
      const rows = await prisma.codeEdge.findMany({
        where: {
          projectId,
          kind: { in: ["writes", "persists-to"] },
          fromSymbolId: { in: symbolIds.slice(i, i + CHUNK) },
        },
        select: { fromSymbolId: true },
        distinct: ["fromSymbolId"],
      });
      for (const r of rows) out.add(r.fromSymbolId);
    }
    return out;
  };
}

/** The production {@link SeedSymbolLoader}: project-scoped, chunked. */
export function prismaSeedSymbolLoader(prisma: Pick<PrismaClient, "codeSymbol">): SeedSymbolLoader {
  const CHUNK = 500;
  return async (symbolIds, projectId) => {
    const rows: SeedSymbolRow[] = [];
    for (let i = 0; i < symbolIds.length; i += CHUNK) {
      rows.push(
        ...(await prisma.codeSymbol.findMany({
          where: { id: { in: symbolIds.slice(i, i + CHUNK) }, projectId },
          select: SEED_SYMBOL_SELECT,
        })),
      );
    }
    return rows;
  };
}
