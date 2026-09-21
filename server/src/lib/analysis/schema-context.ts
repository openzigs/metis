/**
 * Schema-aware context for Sally (the analysis `database` agent) — Issue #732,
 * Epic #725.
 *
 * Sally's objective already asks her to "Identify entities, attributes,
 * relationships, indexing/migration concerns. Cite the source schema or document
 * for every claim." (`prompts.ts`) — but historically she only ever saw
 * document-RAG chunks. This module introspects the project's primary database
 * connector (read-only) and renders a token-budgeted summary of the live schema
 * (tables/entities, key columns, relationships, and — where a persisted usage
 * classification exists — used/unreferenced tags) into a `RetrievalContextChunk`
 * so the orchestrator's `database` branch can merge it with the doc chunks.
 *
 * Design guarantees (mirroring `./fused-code-chunks.ts` #729):
 *   - **Env-gated, ON by default** (`ANALYSIS_SCHEMA_CONTEXT`, flipped on in
 *     #752). Operators can still disable it (`=false`); when disabled this
 *     returns `[]` without touching the introspector, so Sally's context is
 *     byte-identical to the pre-#732 docs-only behaviour.
 *   - **Token-budgeted** (`ANALYSIS_SCHEMA_CONTEXT_TOKEN_BUDGET`,
 *     `ANALYSIS_SCHEMA_CONTEXT_MAX_TABLES`): tables are rendered in a
 *     deterministic order until the budget is reached; the truncated tail is
 *     replaced with an explicit marker so the model knows the summary is partial.
 *   - **Read-only & safe**: introspection never runs DDL and never fetches a
 *     routine body — it reuses the same connector introspection the Impact
 *     Analysis route uses. All reads are scoped to `projectId`.
 *   - **Citable**: the chunk carries a synthetic `documentId` (`live-schema:<projectId>`)
 *     so a finding can cite it deterministically; the UI renders that id as a
 *     "Live schema" label rather than a broken document link.
 *   - **Never throws**: a project with no DB connector, an introspection failure,
 *     or an empty schema all degrade to `[]` — Sally simply falls back to
 *     docs-only retrieval.
 */
import type { DbTableInfo } from "@metis/shared";
import { getConfigService } from "../config/config-service.js";
import { prisma } from "../prisma.js";
import { listDbConnectors, inspectDbConnector } from "../connectors/db/db-service.js";
import { readUsageClassification } from "../impact-analysis/used-schema-classifier.js";
import { createChildLogger } from "../logger.js";
import type { RetrievalContextChunk } from "./agent-runner.js";

const log = createChildLogger("analysis-schema-context");

/**
 * Synthetic `documentId` prefix for the live-schema context chunk. The chunk is
 * not backed by a `Document` row; the prefix keeps its merge-dedupe key
 * (`${documentId}:${chunkIndex}`) disjoint from real document chunks and lets
 * the UI recognise a schema citation and render a friendly label.
 */
export const SCHEMA_DOCUMENT_PREFIX = "live-schema:";

/** Human-facing filename shown on the schema chunk / its citations. */
export const SCHEMA_CONTEXT_FILENAME = "Live database schema";

/** Default token budget for the rendered schema summary (≈4 chars/token). */
export const DEFAULT_SCHEMA_TOKEN_BUDGET = 2000;
/** Default upper bound on tables rendered before the token budget is applied. */
export const DEFAULT_SCHEMA_MAX_TABLES = 60;
/** Default token budget for the name-only index of budget-dropped tables. */
export const DEFAULT_SCHEMA_OVERFLOW_INDEX_TOKEN_BUDGET = 4000;

/** A per-table usage tag drawn from the persisted classification (#297). */
export type SchemaUsageTag = string;

/** The read-only introspection result Sally's schema summary is built from. */
export interface SchemaIntrospection {
  tables: DbTableInfo[];
}

/**
 * Injectable production seam. `introspect` resolves the project's schema (or
 * `null` when the project has no introspectable connector); `readUsage` returns
 * an optional per-table usage tag map keyed by lowercased table name. Both are
 * defaulted to the production implementations below and stubbed in tests.
 */
export interface AnalysisSchemaContextDeps {
  introspect: (projectId: string, actorId: string) => Promise<SchemaIntrospection | null>;
  readUsage?: (projectId: string) => Promise<Map<string, SchemaUsageTag>>;
}

/** 4 chars ≈ 1 token, matching `estTokens` in `../rag/fused-code-context.ts`. */
export function estimateSchemaTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/** The fully-qualified `schema.name` for a table (schema omitted when blank). */
export function tableQualifiedName(table: DbTableInfo): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

/**
 * Look up a table's usage tag tolerantly: the persisted `tableName` may be a
 * bare name or a `schema.name` qualified name depending on the driver, so we try
 * both forms (lowercased). Returns `undefined` when no classification exists.
 */
function lookupUsage(
  usage: Map<string, SchemaUsageTag> | undefined,
  table: DbTableInfo,
): SchemaUsageTag | undefined {
  if (!usage || usage.size === 0) return undefined;
  return usage.get(tableQualifiedName(table).toLowerCase()) ?? usage.get(table.name.toLowerCase());
}

/**
 * Shortest token treated as meaningful for relevance matching. Two- and
 * three-letter tokens ("id", "sku", "the") match a large fraction of any wide
 * schema, which would flatten the ranking rather than sharpen it.
 */
const RELEVANCE_MIN_TERM_LENGTH = 4;

/**
 * Upper bound on the free text scanned for relevance terms. A whole document set
 * yields thousands of distinct terms, at which point nearly every table matches
 * and the signal is gone; bounding the input keeps the term set discriminating
 * and the extraction cost constant.
 */
export const MAX_RELEVANCE_TEXT_CHARS = 20_000;

/**
 * Boilerplate that appears in essentially every requirements document. Left in,
 * these would match a large share of any schema and drown the real signal.
 * Domain nouns are deliberately absent — those are exactly what should match.
 */
const RELEVANCE_STOPWORDS = new Set([
  "shall",
  "must",
  "will",
  "that",
  "this",
  "these",
  "those",
  "with",
  "from",
  "have",
  "been",
  "were",
  "when",
  "then",
  "than",
  "they",
  "them",
  "their",
  "there",
  "which",
  "while",
  "where",
  "what",
  "into",
  "also",
  "such",
  "each",
  "some",
  "only",
  "more",
  "most",
  "other",
  "about",
  "after",
  "before",
  "between",
  "during",
  "under",
  "over",
  "should",
  "would",
  "could",
  "need",
  "needs",
  "required",
  "requirement",
  "requirements",
  "support",
  "provide",
  "provided",
  "include",
  "included",
  "including",
  "following",
  "above",
  "below",
  "note",
  "notes",
  "section",
  "document",
  "project",
  "system",
  "business",
  "process",
  "information",
  "data",
  "table",
  "tables",
  "column",
  "columns",
  "value",
  "values",
  "using",
  "used",
]);

/**
 * Crude singularisation so "JOBS" in a table name matches "jobs" in prose. Applied
 * identically to both sides, so the two always normalise to the same form.
 */
function singularizeTerm(term: string): string {
  if (term.length >= RELEVANCE_MIN_TERM_LENGTH && term.endsWith("s") && !term.endsWith("ss")) {
    return term.slice(0, -1);
  }
  return term;
}

/**
 * Reduce free text (the analysis's extra instructions plus its retrieved document
 * chunks) to the set of normalised terms used to rank tables. Pure and bounded.
 */
export function extractRelevanceTerms(text: string | undefined): Set<string> {
  const terms = new Set<string>();
  if (!text) return terms;
  for (const raw of text
    .slice(0, MAX_RELEVANCE_TEXT_CHARS)
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (raw.length < RELEVANCE_MIN_TERM_LENGTH) continue;
    if (RELEVANCE_STOPWORDS.has(raw)) continue;
    terms.add(singularizeTerm(raw));
  }
  return terms;
}

/**
 * How many distinct parts of a table's qualified name appear in the requirement
 * terms. `0` means the requirement never mentions this table.
 */
function relevanceScore(table: DbTableInfo, terms: Set<string>): number {
  if (terms.size === 0) return 0;
  const matched = new Set<string>();
  for (const part of tableQualifiedName(table)
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (part.length < RELEVANCE_MIN_TERM_LENGTH) continue;
    const normalized = singularizeTerm(part);
    if (terms.has(normalized)) matched.add(normalized);
  }
  return matched.size;
}

/**
 * Render one table as a compact, deterministic block: qualified name (+ usage
 * tag), key columns with pk/fk/nullable annotations, and outbound foreign-key
 * relationships. Pure and offline-safe — the sole input is the introspected
 * `DbTableInfo`.
 */
export function renderTableBlock(table: DbTableInfo, usage?: SchemaUsageTag): string {
  const qn = tableQualifiedName(table);
  const head = usage ? `TABLE ${qn} [${usage}]` : `TABLE ${qn}`;
  const cols = table.columns.map((c) => {
    const flags: string[] = [];
    if (c.isPrimaryKey) flags.push("pk");
    if (c.isForeignKey) flags.push("fk");
    if (c.nullable) flags.push("nullable");
    const suffix = flags.length > 0 ? `, ${flags.join(", ")}` : "";
    return `${c.name} (${c.dataType}${suffix})`;
  });
  const lines = [`${head} — ${table.columns.length} col(s)`, `  cols: ${cols.join(", ")}`];
  if (table.foreignKeys.length > 0) {
    const rels = table.foreignKeys.map((fk) => {
      const refTable = fk.refSchema ? `${fk.refSchema}.${fk.refTable}` : fk.refTable;
      return `${fk.columns.join(",")} → ${refTable}.${fk.refColumns.join(",")}`;
    });
    lines.push(`  fks: ${rels.join("; ")}`);
  }
  return lines.join("\n");
}

/** The result of rendering the schema summary within a token budget. */
export interface SchemaSummary {
  /** The rendered summary text (empty when there are no tables). */
  text: string;
  /** How many tables were rendered into `text`. */
  includedCount: number;
  /** Total tables available before capping/truncation. */
  totalCount: number;
  /** True when the max-tables cap or token budget dropped one or more tables. */
  truncated: boolean;
  /** How many dropped tables were listed by name in the overflow index. */
  indexedCount: number;
}

/**
 * Build a token-budgeted schema summary from the introspected tables. Tables are
 * rendered in a deterministic order (by qualified name) up to `maxTables`, then
 * accumulated until the token budget would be exceeded. Whatever is dropped is
 * signalled with an explicit truncation marker so the model treats the summary
 * as partial. Pure — deterministic for a given input, so it is trivially tested.
 */
export function buildSchemaSummary(
  tables: DbTableInfo[],
  opts: {
    tokenBudget?: number;
    maxTables?: number;
    overflowIndexTokenBudget?: number;
    usage?: Map<string, SchemaUsageTag>;
    /** #1312 — terms from the requirement text; empty preserves pre-#1312 ordering. */
    relevanceTerms?: Set<string>;
  } = {},
): SchemaSummary {
  const totalCount = tables.length;
  if (totalCount === 0) {
    return { text: "", includedCount: 0, totalCount: 0, truncated: false, indexedCount: 0 };
  }
  const tokenBudget = opts.tokenBudget ?? DEFAULT_SCHEMA_TOKEN_BUDGET;
  const maxTables = opts.maxTables ?? DEFAULT_SCHEMA_MAX_TABLES;

  // Deterministic ordering so truncation is stable across runs regardless of the
  // driver's introspection order.
  //
  // Tables the code is KNOWN to touch (usage-tagged) sort ahead of untagged ones.
  // On a large schema, purely alphabetical truncation is close to worthless: a
  // 641-table Oracle schema rendered only its first ~20 names, which were the
  // alphabetically-early administrative/organization tables, so the data-modeling
  // agent correctly reported it could not name a single relevant table. Usage
  // tags are already read for rendering, so ranking by them costs nothing and
  // makes the surviving slice the RELEVANT one. Alphabetical remains the
  // tiebreaker within each group, so ordering is still fully deterministic.
  //
  // #1312 — usage tags alone did not cover the untagged-but-relevant case. On a
  // ~540-table SALESDB schema the job tables the requirement was ABOUT
  // (TRANSACTION_JOBS, TRANSACTION_JOBS_OLD, TRANSACTION_JOBS_CURVE) were
  // untagged and alphabetically late, so they were demoted to the name-only
  // overflow index while alphabetically-early administrative tables kept their
  // column detail. The agent then had to hedge on tables it could see the names
  // of but not the columns. Tables the requirement text actually names now group
  // ahead of untagged non-matching ones. With no terms supplied every table
  // scores 0, both relevance groups collapse, and the ordering is byte-identical
  // to the usage-tag-only behaviour above.
  const terms = opts.relevanceTerms ?? new Set<string>();
  const groupRank = (table: DbTableInfo, score: number): number =>
    (score > 0 ? 0 : 2) + (lookupUsage(opts.usage, table) !== undefined ? 0 : 1);
  const scores = new Map<DbTableInfo, number>(tables.map((t) => [t, relevanceScore(t, terms)]));
  const ordered = [...tables].sort((a, b) => {
    const aScore = scores.get(a) ?? 0;
    const bScore = scores.get(b) ?? 0;
    const aRank = groupRank(a, aScore);
    const bRank = groupRank(b, bScore);
    if (aRank !== bRank) return aRank - bRank;
    if (aScore !== bScore) return bScore - aScore;
    return tableQualifiedName(a).localeCompare(tableQualifiedName(b));
  });
  const capped = ordered.slice(0, maxTables);

  const blocks: string[] = [];
  let used = 0;
  let includedCount = 0;
  for (const table of capped) {
    const block = renderTableBlock(table, lookupUsage(opts.usage, table));
    const cost = estimateSchemaTokens(block) + 1; // +1 for the joining blank line
    // Always include at least one table so a single oversized table still yields
    // a (partial-marked) summary rather than an empty fence.
    if (includedCount > 0 && used + cost > tokenBudget) break;
    blocks.push(block);
    used += cost;
    includedCount += 1;
  }

  const truncated = includedCount < totalCount;
  let indexedCount = 0;
  if (truncated) {
    blocks.push(
      `… ${totalCount - includedCount} more table(s) omitted (schema summary truncated to fit the analysis token budget).`,
    );
    // A full block for a wide table costs ~450 tokens but its name costs ~7, so
    // naming the dropped tail is affordable at any realistic schema size. Without
    // it a 540-table schema renders ~60 tables and the model caveats every gap
    // with "this column could exist in a table I was not shown", which is what
    // depressed confidence on the SALESDB run.
    const overflowBudget =
      opts.overflowIndexTokenBudget ?? DEFAULT_SCHEMA_OVERFLOW_INDEX_TOKEN_BUDGET;
    const names: string[] = [];
    let indexUsed = 0;
    for (const dropped of ordered.slice(includedCount)) {
      const name = tableQualifiedName(dropped);
      const cost = estimateSchemaTokens(`${name}, `);
      if (indexUsed + cost > overflowBudget) break;
      names.push(name);
      indexUsed += cost;
    }
    indexedCount = names.length;
    if (indexedCount > 0) {
      const unlisted = totalCount - includedCount - indexedCount;
      const tail = unlisted > 0 ? `\n… and ${unlisted} further table name(s) not listed.` : "";
      blocks.push(
        `NAMES OF OMITTED TABLES (no column detail shown; these tables DO exist — do not report one as absent merely because it is missing above):\n${names.join(", ")}${tail}`,
      );
    }
  }

  return { text: blocks.join("\n\n"), includedCount, totalCount, truncated, indexedCount };
}

/**
 * Wrap a schema summary into a single citable `RetrievalContextChunk`. The text
 * leads with a labelled header so the model knows what it is looking at and how
 * to cite it. Returns `null` when the summary is empty (no tables) so callers
 * can treat "no schema" uniformly.
 */
export function schemaSummaryToContextChunk(
  projectId: string,
  summary: SchemaSummary,
): RetrievalContextChunk | null {
  if (summary.text.length === 0) return null;
  const documentId = `${SCHEMA_DOCUMENT_PREFIX}${projectId}`;
  const header = `LIVE DATABASE SCHEMA (introspected read-only from the project's primary connector — authoritative reference for entities, attributes and relationships; cite documentId=${documentId} when you rely on it):`;
  return {
    documentId,
    chunkIndex: 0,
    filename: SCHEMA_CONTEXT_FILENAME,
    text: `${header}\n\n${summary.text}`,
  };
}

/**
 * Production introspector: primary DB connector, read-only, `null` when none.
 *
 * #1312 — also the seam behind the `describe_table` tool, so the agent's on-demand
 * lookups hit exactly the same read-only introspection as the passive summary.
 */
export function introspectProjectSchema(
  projectId: string,
  actorId: string,
): Promise<SchemaIntrospection | null> {
  return (async () => {
    const connectors = await listDbConnectors(projectId);
    if (connectors.length === 0) return null;
    const snapshot = await inspectDbConnector(projectId, connectors[0].id, actorId);
    return { tables: snapshot.tables };
  })();
}

/** Production usage reader: persisted classification → lowercased table→tag map. */
async function defaultReadUsage(projectId: string): Promise<Map<string, SchemaUsageTag>> {
  const rows = await readUsageClassification(prisma, projectId);
  const map = new Map<string, SchemaUsageTag>();
  for (const r of rows) {
    if (r.kind !== "table") continue;
    const tag = r.overriddenClass ?? r.usageClass;
    if (tag) map.set(r.tableName.toLowerCase(), tag);
  }
  return map;
}

/**
 * Retrieve the schema-context chunk(s) for Sally's context. Returns `[]`
 * (introspector untouched) when the feature is disabled — the flag-off path
 * reproduces today's docs-only behaviour exactly.
 *
 * `enabled` / `tokenBudget` / `maxTables` default to the `ANALYSIS_SCHEMA_CONTEXT*`
 * config keys (ON / 2000 / 60); `deps` defaults to the production read-only
 * connector introspection + persisted usage classification. Never throws: a
 * missing connector, an introspection failure, or an empty schema all degrade to
 * `[]`.
 */
export async function retrieveSchemaContextChunks(opts: {
  projectId: string;
  actorId: string;
  enabled?: boolean;
  tokenBudget?: number;
  maxTables?: number;
  /**
   * #1312 — free text describing what this analysis is about (extra instructions
   * plus the retrieved document chunks). Tables it names keep their column detail
   * instead of being demoted to the name-only overflow index. Omitted ⇒ ordering
   * is byte-identical to the usage-tag-only behaviour.
   */
  relevanceText?: string;
  deps?: AnalysisSchemaContextDeps;
}): Promise<RetrievalContextChunk[]> {
  const cfg = getConfigService();
  const enabled = opts.enabled ?? cfg.getBool("ANALYSIS_SCHEMA_CONTEXT", true);
  if (!enabled) return [];

  const deps: AnalysisSchemaContextDeps = opts.deps ?? {
    introspect: introspectProjectSchema,
    readUsage: defaultReadUsage,
  };

  try {
    const introspection = await deps.introspect(opts.projectId, opts.actorId);
    if (!introspection || introspection.tables.length === 0) return [];

    const usage = deps.readUsage
      ? await deps.readUsage(opts.projectId).catch(() => new Map<string, SchemaUsageTag>())
      : undefined;

    const summary = buildSchemaSummary(introspection.tables, {
      tokenBudget:
        opts.tokenBudget ??
        cfg.getNumber("ANALYSIS_SCHEMA_CONTEXT_TOKEN_BUDGET", DEFAULT_SCHEMA_TOKEN_BUDGET),
      maxTables:
        opts.maxTables ??
        cfg.getNumber("ANALYSIS_SCHEMA_CONTEXT_MAX_TABLES", DEFAULT_SCHEMA_MAX_TABLES),
      overflowIndexTokenBudget: cfg.getNumber(
        "ANALYSIS_SCHEMA_CONTEXT_OVERFLOW_INDEX_TOKEN_BUDGET",
        DEFAULT_SCHEMA_OVERFLOW_INDEX_TOKEN_BUDGET,
      ),
      usage,
      relevanceTerms: extractRelevanceTerms(opts.relevanceText),
    });

    const chunk = schemaSummaryToContextChunk(opts.projectId, summary);
    return chunk ? [chunk] : [];
  } catch (err) {
    // Graceful degradation — Sally falls back to docs-only retrieval.
    log.warn("schema-context retrieval failed (non-fatal); falling back to docs-only", {
      projectId: opts.projectId,
      error: (err as Error).message,
    });
    return [];
  }
}
