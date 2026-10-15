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
 * Read-only, and never throws: a search fault yields no seeds.
 */
import type { PrismaClient } from "@prisma/client";
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
  return !STORED_DATA_CHANGE_RE.test(
    `${change.title}\n${change.body}`.slice(0, MAX_SEED_QUERY_CHARS * 4),
  );
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
  const byFile = new Map<string, number[]>();
  for (const h of hits) byFile.set(h.filePath, [...(byFile.get(h.filePath) ?? []), h.score]);
  const ranked = [...byFile.entries()]
    .map(([filePath, scores]) => ({ filePath, score: fileScore(scores) }))
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
  const best = ranked[0]?.score ?? 0;
  if (best <= 0) return [];
  return ranked
    .filter((f) => f.score >= best * MIN_FILE_SHARE)
    .slice(0, MAX_EDIT_FILES)
    .map((f) => f.filePath);
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
  const editFiles = new Set(
    rankEditFiles(editable.map((h) => ({ filePath: h.row.filePath, score: h.score * boost(h) }))),
  );

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

  return { editCandidates, related, schemaSeeds, retrievalMode };
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
