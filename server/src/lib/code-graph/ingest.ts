/**
 * Epic #298 / Issue #308 — Code-graph ingest pipeline.
 *
 * Walks a project directory, applies `.metisignore`, parses each source file,
 * and persists symbols / edges / rationale findings to the database. Designed
 * to be idempotent: on a re-run the SHA256 file hash is compared against the
 * previously-persisted hash and unchanged files are skipped.
 *
 * Invoked directly from tests, CLI utilities, or higher-level orchestration.
 * Connector-flow integration is tracked as a follow-up.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getHeapStatistics } from "node:v8";
import type { Prisma, PrismaClient } from "@prisma/client";
import { compileMetisignore, DEFAULT_METISIGNORE, isIgnored } from "./metisignore.js";
import {
  detectLanguage,
  initCodeGraphParsers,
  parseSource,
  type ParsedEdge,
  type ParsedFile,
} from "./parsers.js";
import { buildCopybookIndex, resolveCopybook, type CopybookIndex } from "./cobol-parser.js";
import {
  createResolutionIndex,
  indexSymbol,
  isKotlinConstructorCandidate,
  isRuntimeOrTestModule,
  KOTLIN_CONSTRUCTIBLE_LANGUAGES,
  reclassifyKotlinConstructorCall,
  resolveEdgeTarget,
  type ResolutionIndex,
  type ResolvableSymbol,
} from "./call-resolution.js";
import { createEventLoopYielder, type MaybeYield } from "./event-loop-yield.js";
import {
  createGoResolver,
  goDir,
  GO_RESOLUTION_NAME,
  goResolutionMetadata,
  parseGoModulePath,
  type GoCallVerdict,
  type GoExpr,
  type GoResolution,
  type GoModule,
  type GoResolver,
  type GoResolverFile,
} from "./go-type-resolution.js";
import type { DbDependencyInfo, DbPackageInfo, DbRoutineInfo } from "@metis/shared";
import { extractRoutineDependencies } from "./routine-dependency-extractor.js";
import { extractPlsqlPackageLineage, type PackageBodyFetcher } from "./plsql-package-lineage.js";
import { extractRationale } from "./rationale-extractor.js";
import { extractEmbeddedSql } from "./embedded-sql-extractor.js";
import { extractSasProcSql } from "./sas-rule-miner.js";
import { extractRoutineUsage } from "./routine-usage-extractor.js";
import { extractRoutineBodies, type RoutineBodyFetcher } from "./routine-body-extractor.js";
import { SchemaGraphWriter } from "./schema-graph.js";
import { createChildLogger } from "../logger.js";
import { persistOrmFile } from "./orm-extractor.js";
import {
  buildEfCoreEntityResolver,
  buildJpaEntityResolver,
  buildSqlAlchemyEntityResolver,
} from "./entity-resolver.js";
import {
  buildEfDbSetTableMap,
  findEfCallSites,
  persistEfCallSiteEdges,
} from "./ef-callsite-extractor.js";
import {
  persistJpaQueryFile,
  persistJpaQueryOriginEdges,
  type JpaQueryOrigin,
} from "./jpa-query-extractor.js";
import { persistMyBatisFile, type MyBatisStatementOrigin } from "./mybatis-extractor.js";
import {
  buildOrmModelTableMap,
  findOrmCallSites,
  persistOrmCallSiteEdges,
  type EnclosingSymbol,
} from "./orm-callsite-extractor.js";
import {
  buildJooqTableMap,
  findJooqCallSites,
  persistJooqCallSiteEdges,
} from "./jooq-extractor.js";
import { findSqlAlchemyCallSites, persistSqlAlchemyCallSiteEdges } from "./sqlalchemy-extractor.js";
import {
  buildGormEntityResolver,
  findGormCallSites,
  persistGormCallSiteEdges,
} from "./gorm-extractor.js";
import {
  buildJavaMapperIndex,
  buildMapperMethodSymbolIndex,
  buildMapperMethodsBySimpleName,
  persistMapperCallerEdges,
  persistMyBatisStatementOriginEdges,
} from "./mybatis-callsite-extractor.js";
import {
  buildIntrospectedSchemaFromSymbols,
  isSqlLineageEnabled,
  probeSqlLineageSidecar,
  trackSqlLineageReachability,
  type IntrospectedSchema,
  type SqlLineageClient,
} from "./sql-lineage-client.js";
import {
  computeSymbolHash,
  formatSymbolForEmbedding,
  type SymbolKind as EmbeddingSymbolKind,
} from "./symbol-embeddings.js";
import { enqueueSymbolEmbeddings } from "./symbol-embedding-service.js";
import {
  extractOwnFileContext,
  packageOfFile,
  receiverOf,
  shippedContextLines,
  type ContextSourceSymbol,
  type OwnFileContext,
} from "./symbol-context.js";
import { reconcileProjectSchemaIdentities } from "../cross-project/schema-object-identity-service.js";

const log = createChildLogger("code-graph-ingest");

export interface IngestOptions {
  projectId: string;
  rootDir: string;
  /** Optional connector-id used for the CodeGraph FK. */
  repoConnectionId?: string;
  /**
   * Optional commit SHA the graph is built from. Recorded on the CodeGraph row
   * and, with `repoConnectionId`, as `RepoConnection.lastCommitSha` — both only
   * once the ingest has finished, so a failed run leaves the two labels on the
   * commit the graph still reflects (#758).
   */
  commitSha?: string;
  /**
   * When true, skip files whose recorded `contentHash` matches the on-disk
   * SHA256. Defaults to true. Set false to force a full re-ingest.
   */
  incremental?: boolean;
  /**
   * #1071 — the ceiling on time spent resolving Go calls by type for this run;
   * defaults to {@link GO_BINDING_MAX_MS}.
   */
  goBindingMaxMs?: number;
  /**
   * #1071 — the fewest Go calls one run resolves by type whatever the ceiling
   * says; defaults to {@link GO_BINDING_MIN_CALLS}. It is what makes an
   * interrupted binding converge: every ingest finishes at least this many of
   * the calls still open.
   */
  goBindingMinCalls?: number;
  /**
   * #1071 — the clock the ceiling is measured with, in milliseconds; defaults
   * to `performance.now`. A seam for tests, so that a ceiling can be made to
   * trip after an exact number of calls instead of whenever the machine says.
   */
  goBindingNow?: () => number;
  /**
   * #1071 — the heap growth, in bytes, at which this run stops resolving Go
   * calls; defaults to {@link defaultGoBindingHeapLimit}. Like the clock, a
   * seam for tests and for whoever calls `ingestCodeGraph` in code: no route
   * reads it from a request.
   */
  goBindingMaxHeapGrowth?: number;
  /**
   * #1071 — what the heap watchdog reads, in bytes; defaults to
   * `process.memoryUsage().heapUsed`. A seam for tests, so that the watchdog
   * can be made to trip at an exact sample.
   */
  goBindingHeapUsed?: () => number;
  /**
   * User who triggered the ingest. Required for rationale-finding persistence
   * because the Finding→AgentResult→Analysis chain needs a User row. When
   * omitted, rationale extraction still runs but findings are not written —
   * the count is still reflected in `stats.rationaleFindings` for visibility.
   */
  triggeredByUserId?: string;
  /**
   * The project's already-introspected DB schema in the sqlglot shape
   * (`{ db: { table: { column: type } } }`) — Epic #294 (#317). When supplied it
   * is threaded into EVERY SQL-lineage extraction so sqlglot can expand `SELECT *`
   * and qualify bare columns (the column-accuracy lever). Omit (or pass null) when
   * the project has no reachable DB connection — extraction then behaves exactly
   * as before (table-level + explicitly-named-column edges only). Build it from
   * `driver.introspect()` via `buildIntrospectedSchema`.
   */
  introspectedSchema?: IntrospectedSchema | null;
  /**
   * #721 — true when the project HAS a DB connector but introspecting it failed
   * (an outage, missing grants), so {@link introspectedSchema} is null for want
   * of an answer rather than because there is no database. The lineage
   * fingerprint then keeps the schema component it was last built with: a
   * transient outage neither forces a re-parse nor makes the DB's return force
   * a second one. Omit (false) when there is no connector, or it was read.
   */
  introspectionFailed?: boolean;
  /**
   * Live-introspected routines (procedures & functions) whose BODIES should be
   * parsed for `calls` edges — Epic #294 (#316B). Supplied together with
   * {@link fetchRoutineBody}. Omit when no DB connection is available; routine
   * `calls` extraction is then skipped (no regression).
   */
  routines?: DbRoutineInfo[];
  /**
   * READ-ONLY routine-body fetcher (bound to a DB driver) — Epic #294 (#316B).
   * Used with {@link routines} to fetch + parse routine bodies. The body is only
   * PARSED by the sidecar, NEVER executed. Omit to skip `calls` extraction.
   */
  fetchRoutineBody?: RoutineBodyFetcher;
  /** Dialect hint forwarded to the sidecar for routine-body parsing (#316B). */
  routineDialect?: string;
  /**
   * Live-introspected PL/SQL PACKAGES whose bodies should be parsed for Tier-2
   * member-level `reads`/`writes`/`persists-to` edges — Epic #881 Phase 3
   * (#893), wired into ingest by #953. Supplied together with
   * {@link fetchPackageBody}. Omit when no Oracle DB connection is available;
   * package-body lineage is then skipped (no regression). The package body is
   * fetched READ-ONLY and only PARSED — never executed.
   */
  packages?: DbPackageInfo[];
  /**
   * READ-ONLY PL/SQL package-BODY fetcher (bound to a DB driver) — #953. Used
   * with {@link packages} to fetch + statically preprocess (#892) + per-
   * statement parse (#893) package bodies. The body is only PARSED by the
   * sidecar, NEVER executed. Omit to skip package-body lineage.
   */
  fetchPackageBody?: PackageBodyFetcher;
  /**
   * Coarse Tier-1 object-dependency rows (Epic #881 Phase 1, #890) —
   * `driver.introspectDependencies()` output — turned into coarse `calls`
   * edges (`source = "catalog-deps"`) via {@link extractRoutineDependencies}.
   * Zero-parse, no sidecar required. Omit when the driver doesn't support
   * dependency introspection; no regression.
   */
  dependencies?: DbDependencyInfo[];
  /**
   * Epic #882 (#894) — the ALREADY-RESOLVED per-project SQL-lineage decision
   * (`resolveProjectSqlLineage`). `true`/`false` forces the extraction pass on
   * or off for this ingest regardless of the platform `SQL_LINEAGE_MODE`
   * default; omit (or pass `undefined`/`null`) to keep the pre-#894
   * platform-only gate (byte-identical to before).
   */
  sqlLineageOverride?: boolean | null;
  /**
   * Epic #780 / Issue #797 — enqueue the background symbol-embedding job once
   * the graph is written. Covers BOTH a fresh BUILD and a scheduled REFRESH,
   * because both go through `ingestCodeGraph`.
   *
   * The job is NEVER awaited: a cold build of METIS is ~15k symbols ≈ 235
   * sidecar posts ≈ 45–95 minutes, which cannot sit inside an HTTP ingest
   * request or the scheduler's abort-guard cadence. An incremental refresh
   * re-embeds only the symbols of the files that actually changed.
   *
   * OPT-IN (default `false`) so tests and CLI ingests do not reach for the
   * embedder. Production call sites — the connector ingest routes and the
   * scheduled-refresh handler — pass `true`. The `CodeSymbolEmbedding` rows are
   * written either way, so a run with this off leaves the work durable and
   * pending, not lost.
   */
  embedSymbols?: boolean;
}

export interface IngestStats {
  codeGraphId: string;
  filesScanned: number;
  filesParsed: number;
  filesSkipped: number;
  symbolsUpserted: number;
  edgesUpserted: number;
  rationaleFindings: number;
  /**
   * Schema-usage edges written by the SQL-lineage extractors (#305 embedded SQL,
   * #306 SAS PROC SQL) with `source = "sqlglot"`. Zero when the sidecar is
   * disabled (`SQL_LINEAGE_MODE != sidecar`) or unreachable — see
   * {@link extractSchemaUsage}.
   */
  schemaEdges: number;
  /**
   * Routine schema edges written by the SQL-lineage path (#316): code→routine
   * `executes` edges (from detected CALL/EXEC/SELECT-fn invocations) plus
   * routine→object `calls` edges (from statically-parsed routine bodies). Zero
   * when the sidecar is disabled/unreachable. Counted separately from
   * {@link schemaEdges} (table/column reads/writes) for visibility.
   */
  routineEdges: number;
  /**
   * #313 — unchanged files whose edges an incremental ingest re-resolved because
   * a symbol they could bind to was added, changed or deleted. Zero on a full
   * ingest and on an incremental one that changed nothing they reference.
   */
  filesRebound: number;
  /**
   * #1071 — unchanged files brought up to {@link CODE_GRAPH_EXTRACTOR_VERSION}
   * in place: their symbols keep their ids (only a changed qualified name is
   * rewritten) and their parser edges are re-derived. Zero unless the graph was
   * built by an older extractor.
   */
  filesUpgraded: number;
  /**
   * #1071 — files an extractor upgrade could not bring to
   * {@link CODE_GRAPH_EXTRACTOR_VERSION} (unreadable, or the current parser
   * gives up on them), by path, up to {@link NAMED_FILES_CAP}: the ones that
   * failed in this run AND the ones an earlier run left behind that are still
   * as they were. Their rows keep the old shape. They are remembered on the
   * graph with the hash of the content that failed
   * (`CodeGraph.extractorUpgradeFailed`), so the upgrade is not repeated for
   * the rest of the tree, and a listed file is tried again only when its
   * content changes. {@link filesUpgradeFailedCount} is the uncapped count.
   */
  filesUpgradeFailed: string[];
  filesUpgradeFailedCount: number;
  /**
   * #1071 — files this run could not parse at all, by path, up to
   * {@link NAMED_FILES_CAP}: changed files the walk skipped (they are inside
   * {@link filesSkipped}, and whatever rows the graph held for them are stale)
   * and unchanged files a re-bind or an upgrade could not re-parse.
   * {@link filesUnparseableCount} is the uncapped count.
   */
  filesUnparseable: string[];
  filesUnparseableCount: number;
  /**
   * #1072 — what bringing a graph written before {@link SYMBOL_CONTEXT_VERSION}
   * up to it did: `symbols` rows whose context columns were filled in,
   * `embeddingTexts` embedding texts rewritten (each is embedded again, once),
   * `failedFiles` unchanged files it could not read. The version is recorded
   * only when `failedFiles` is zero, so the next ingest tries again. Absent
   * when the graph was already current, and on a full ingest.
   */
  symbolContextBackfill?: { symbols: number; embeddingTexts: number; failedFiles: number };
  /**
   * #1071 — what binding Go calls by type cost this run, and what it could not
   * do. Any change to one Go file re-parses EVERY Go file of the tree for its
   * declarations, so this is O(Go files) per ingest: `files` Go files held,
   * `calls` call edges decided, `durationMs` spent parsing unchanged Go files
   * and resolving. Null when the run resolved no Go call.
   *
   * Three counters say how many calls were left UNDECIDED BY TYPE for a reason
   * that is not in the source. Such a call is never given a decided verdict;
   * it goes on to the name-evidence rules exactly as before #1071, so it can
   * still be bound, labelled `name`.
   *
   *  - `errors` — resolving it threw (a resolver bug). `failures` names them,
   *    `file:line callee`, up to {@link NAMED_FILES_CAP};
   *  - `overBudget` — resolving it would have passed the resolver's step
   *    budgets (`GO_CALL_STEP_BUDGET`, `GO_TYPE_STEP_BUDGET`) or needed a type
   *    to keep more than it may (`GO_TYPE_LAYER_BUDGET`,
   *    `GO_TYPE_RETAINED_PER_MEMBER`): the resolver's memory is bounded by
   *    refusing the type, never by a wrong answer;
   *  - `skipped` — the whole step had already used {@link GO_BINDING_MAX_MS}
   *    when the call came up (and {@link GO_BINDING_MIN_CALLS} calls had been
   *    resolved), or its heap had grown past
   *    {@link GO_BINDING_MAX_HEAP_GROWTH}. Non-zero means this ingest's Go
   *    binding is INCOMPLETE, and `stopReason` says which of the two it was.
   *
   * None of the three ever REPLACES an answer the graph already holds: the
   * stored row of an unchanged file's call is left as it is. Only a file that
   * was itself re-parsed has no stored answer to keep, and gets the
   * name-evidence one.
   *
   * `incomplete` is what the time ceiling left open after this run — the files
   * with calls not resolved by type on the tree as it is now, and how many
   * calls that is (counted for the files this run read) — or null when
   * nothing is. It is recorded on the graph (`CodeGraph.goBindingIncomplete`,
   * {@link GoBindingIncomplete}), and the next ingest resumes there FIRST,
   * whether or not a Go file changed. `resumedFiles` is how many files this
   * run took up from such a record. Over-budget and failed calls are not in
   * it: resolving them again would end the same way.
   */
  goBinding: {
    files: number;
    calls: number;
    durationMs: number;
    errors: number;
    failures: string[];
    overBudget: number;
    skipped: number;
    /**
     * Why the step stopped before its last call: `time`
     * ({@link GO_BINDING_MAX_MS}) or `memory`
     * ({@link GO_BINDING_MAX_HEAP_GROWTH}); null when it did not.
     */
    stopReason: "time" | "memory" | null;
    /** On a `memory` stop, the heap growth sampled when it tripped, in MB; else null. */
    heapGrowthMb: number | null;
    resumedFiles: number;
    incomplete: { files: number; calls: number } | null;
    /**
     * Files whose remaining calls are no longer resumed: they were still open
     * after every ingest the floor needs and {@link GO_BINDING_RESUME_GRACE}
     * more (`CodeGraph.goBindingIncomplete.abandoned`).
     */
    abandonedFiles: number;
  } | null;
  /**
   * #721 — true when an incremental ingest re-extracted the lineage of every
   * file because the SQL-lineage inputs (lineage decision or introspected
   * schema) differ from the ones the graph was last built with, so lineage
   * backfills over files whose content did not change. Since #856 those files
   * are not re-parsed: only their lineage rows are rewritten (see
   * {@link filesLineageRefreshed}). False on a fresh graph, an unchanged run
   * and an explicitly non-incremental one.
   *
   * Turning lineage OFF also changes the inputs, so it too forces one backfill
   * — the one that removes the lineage edges every file carried — and
   * reports `true` here. So does the first ingest with a reachable sidecar
   * after one where lineage was on but the sidecar could not be reached.
   */
  lineageBackfill: boolean;
  /**
   * #856 — unchanged files whose SQL lineage a backfill re-extracted without
   * re-persisting them: their symbols, parser edges, embeddings and every link
   * into them keep their ids. Zero unless {@link lineageBackfill} is true.
   */
  filesLineageRefreshed: number;
  /**
   * #715 — files an incremental run skipped because their content hash matched
   * the graph: they are in the graph, just not re-parsed. Counted inside
   * {@link filesSkipped}, which also holds files in no code-graph language.
   */
  filesUnchanged: number;
  /**
   * #715 — the graph as a whole after this run, not this run's delta: the
   * files it holds (one `module` symbol each), its symbols and its edges.
   * `filesParsed` / `symbolsUpserted` / `edgesUpserted` describe only what an
   * incremental run re-parsed, which read as the graph's size.
   */
  graphFiles: number;
  graphSymbols: number;
  graphEdges: number;
  languageStats: Record<string, number>;
  durationMs: number;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Public entry point. Returns ingest statistics. Throws on unrecoverable
 * errors (e.g. project not found); per-file parse errors are swallowed and
 * counted as `filesSkipped`.
 */
/**
 * Strip literal NUL (0x00) bytes from ingested source text. Postgres rejects
 * `0x00` in `text`/`varchar` values (`invalid byte sequence for encoding
 * "UTF8"`) and aborts the whole insert transaction, whereas SQLite silently
 * stores it — so a single repo file containing a NUL (e.g. a NUL-handling test
 * fixture, or a stray binary the walker treated as text) would break the entire
 * code-graph ingest on Postgres while passing on the SQLite dev store. Sanitise
 * at the read chokepoint so every downstream symbol/edge/content value is
 * NUL-free. Cheap no-op for the overwhelmingly common NUL-free file.
 */
export function stripNulBytes(s: string): string {
  return s.includes("\u0000") ? s.replace(/\u0000/g, "") : s;
}

/**
 * #760 / #807 — version of what the SQL-lineage pass writes for unchanged
 * inputs. Bump it whenever the extractors (or the sidecar contract) change the
 * edges an unchanged file produces: a stored fingerprint with another version
 * (or none — every pre-#807 graph) compares as changed, so the next ingest with
 * lineage on re-parses everything once and rewrites the edges, without a manual
 * re-ingest. History: unversioned = #721; 2 = #760 (bind parameters dropped,
 * WHERE columns read not written, edges from the enclosing function); 3 = #859
 * (writes attributed to the modified table only, SQL builtins skipped — shipped
 * by #873 without a bump, applied by #935).
 *
 * Two sets of extractors feed it, and only one is guarded:
 * - The sidecar: `tests/lib/code-graph/lineage-extractor-version.test.ts` pins a
 *   hash of `metis-sql-lineage/app/**.py` plus its runtime `requirements.txt`
 *   (the `sqlglot` pin) to this number, so changing either fails until bumped.
 * - The server-side TS extractors (embedded-sql, gorm, sqlalchemy,
 *   sql-lineage-resolver, plsql-package-lineage) need the same bump when they
 *   change the edges an unchanged file produces. That test does NOT guard them.
 */
export const LINEAGE_EXTRACTOR_VERSION = 3;

/**
 * #1071 — version of what the PARSERS write for an unchanged file: a symbol's
 * qualified name, and how a parser edge is bound. An incremental ingest skips a
 * file whose content hash matches, so a parser change reaches a stored graph
 * only through this number: a graph recorded with an older one (or none — every
 * graph built before #1071) has the files of the languages that changed since
 * ({@link EXTRACTOR_UPGRADES}) upgraded in place on its next ingest.
 *
 * "In place" is the point (#856): the files are re-parsed, but their symbol
 * rows are kept — a changed qualified name is rewritten on the existing row —
 * so every finding, requirement mapping and embedding that points at a symbol
 * id survives. Only the file's parser edges (`calls` / `imports` / `defines` /
 * `references`, `source` null) are deleted and re-derived. This works for a
 * change that renames or re-binds; a change to WHICH symbols a file yields
 * needs a full re-ingest (`incremental: false`) instead.
 *
 * History: unversioned = before #1071; 1 = #1071 (a Go method is named
 * `<file>::<ReceiverType>::<name>`, and Go calls are bound by declared types).
 */
export const CODE_GRAPH_EXTRACTOR_VERSION = 1;

/** The languages whose stored rows each extractor version changed. */
const EXTRACTOR_UPGRADES: ReadonlyArray<{ version: number; languages: readonly string[] }> = [
  { version: 1, languages: ["go"] },
];

/**
 * #1072 — version of what ingest stores about a symbol FROM ITS OWN FILE beyond
 * the parser's rows: the context columns (`signature`, `docComment`,
 * `receiver`, `package`) and the embedding text built with them. Bump it
 * whenever `extractOwnFileContext` or `shippedContextLines`
 * (`symbol-context.ts`) would give an unchanged file a different answer;
 * `tests/code-graph-symbol-context-1072.sqlite.test.ts` pins their output to
 * this number.
 *
 * A graph recorded with an older one (or none — every graph built before
 * #1072) has the columns filled in for every unchanged file on its next
 * incremental ingest ({@link backfillSymbolContext}), on the existing rows: no
 * symbol id changes. An embedding text that comes out different is rewritten
 * and marked pending, so that symbol is embedded again, once.
 *
 * It is a number of its own, not a {@link CODE_GRAPH_EXTRACTOR_VERSION} step,
 * because it needs none of that upgrade's work: nothing is re-parsed (the
 * stored line span is enough), no edge is touched, and no Go call is re-bound.
 * It also must not wait on an interrupted Go binding, which holds that
 * version back.
 *
 * History: unversioned = before #1072; 1 = #1072.
 */
export const SYMBOL_CONTEXT_VERSION = 1;

/** The languages a graph recorded at `storedVersion` must have upgraded in place. */
export function extractorUpgradeLanguages(storedVersion: number | null): Set<string> {
  const out = new Set<string>();
  for (const u of EXTRACTOR_UPGRADES) {
    if (u.version > (storedVersion ?? 0)) for (const l of u.languages) out.add(l);
  }
  return out;
}

/** Most file paths one ingest names in a stats list or a log line; the count is never capped. */
export const NAMED_FILES_CAP = 50;

/**
 * #1071 — the most time one ingest spends resolving Go calls by type (building
 * the resolver and every `resolveCall`, summed; parsing and database writes
 * are not counted). The resolver is linear in declarations plus calls and
 * takes about 50 ms for a 21,000-call tree, so this is a ceiling for input
 * nobody measured, not a working limit. Once it is reached the remaining calls
 * are left undecided by type (`IngestStats.goBinding.skipped`), a warning
 * names the count, and the ingest goes on: a slow resolver never holds an
 * ingest for minutes. Overridable per run with `IngestOptions.goBindingMaxMs`.
 *
 * What the ceiling leaves is not lost and not silent: the stored answer of a
 * skipped call is kept, the graph records where each file stopped
 * (`CodeGraph.goBindingIncomplete`, {@link GoBindingIncomplete}), and the next
 * ingest takes it up from there.
 */
export const GO_BINDING_MAX_MS = 30_000;

/**
 * #1071 — the fewest Go calls one ingest resolves by type, whatever
 * {@link GO_BINDING_MAX_MS} says. It is what guarantees that an interrupted
 * binding finishes: each ingest closes at least this many of the calls still
 * open, even when building the resolver alone uses the whole ceiling. It
 * counts calls, not time, so no verdict depends on it.
 *
 * What it can ADD to the ceiling is what these calls cost, and one call is
 * not cheap by construction: the call that first reaches a type pays for that
 * type's layers, up to `GO_TYPE_STEP_BUDGET` steps, and a callee chain can
 * first-reach one type per link. Measured through the real walker and
 * resolver on an idle laptop (PR #1104 review cycle 4):
 *
 *  - a call on a type already seen: 0.0002 to 0.0007 ms;
 *  - the first call on a type that embeds a 3,000-field struct: 0.002 ms
 *    median, 0.005 mean (0.56 ms while a type's members were copied);
 *  - the first call on a type AT the step budget (87,253 steps: a lattice of
 *    660 types): 3 ms median, 12 ms at worst.
 *
 * So on hand-written Go the floor costs a few milliseconds; on a tree built so
 * that each of the 2,000 calls first-reaches its own type at the budget it
 * adds about 6 seconds to the ceiling, and several times that if each call's
 * chain reaches several such types. That is bounded, and never a hang; it is
 * not "a fraction of a second", which an earlier version of this comment said.
 */
export const GO_BINDING_MIN_CALLS = 2_000;

/**
 * #1071 — the heap growth at which an ingest STOPS resolving Go calls: the
 * last resort against a resolver that retains more than it says.
 *
 * The resolver bounds what it keeps and counts it (`GoResolver.retained`).
 * Twice a review found a structure that count did not see — a flattened member
 * table per type, then a copy of a struct's fields per defined type — and each
 * time 1 to 2 MB of Go ended the process: `JavaScript heap out of memory` is
 * an abort, not an exception, so nothing catches it and every ingest in the
 * process dies with it. This watchdog does not trust that accounting. It reads
 * the heap itself, every {@link GO_BINDING_HEAP_SAMPLE_CALLS} calls and
 * whenever the resolver has kept {@link GO_BINDING_HEAP_SAMPLE_ENTRIES} more
 * entries, and when
 * the heap has grown by more than this since the step began it stops the step
 * exactly as the time ceiling does: the remaining calls keep the answer they
 * have, the graph records where each file stopped and is not stamped, the
 * resolver is released — its caches with it — and the stats and the log say
 * `stopReason: "memory"`.
 *
 * 512 MB, because of what was measured through the real walker and resolver
 * (PR #1104 review cycle 5): the widest shapes that resolve correctly — 48,000
 * types over one 3,000-member declaration, 2 to 5.6 MB of Go in one package —
 * peak at 65 to 240 MB of growth, and a real ingest of Miniflux (21,106 calls)
 * at 12 MB as this watchdog reads it. So the limit is twice the worst
 * legitimate case found and forty times a real repository; and it is an
 * eighth of Node's 4 GB default heap, which leaves the rest of the server its
 * room. On a smaller heap the limit is a quarter of the heap instead
 * ({@link defaultGoBindingHeapLimit}). At Miniflux's 0.6 KB a call it would be
 * reached near 900,000 calls in ONE ingest: a tree that large is then bound
 * over several ingests, each with a new resolver, like any other binding the
 * ceiling interrupted — slower, and never an abort.
 *
 * Unlike every other limit of this step it is ORDER-dependent, and has no
 * floor: which call it stops at depends on what else the process holds and on
 * when the collector last ran, and it can stop an ingest before
 * {@link GO_BINDING_MIN_CALLS} calls. That is accepted here and nowhere else —
 * the alternative is the abort. No VERDICT depends on it: a call is resolved
 * in full or not looked at. A tree that trips it on every ingest is given up
 * after the usual allowance ({@link GO_BINDING_RESUME_GRACE}).
 */
export const GO_BINDING_MAX_HEAP_GROWTH = 512 * 1024 * 1024;

/**
 * #1071 — how often the heap watchdog reads the heap at least: before every
 * 256th call handed to the resolver (the first included, which covers
 * building it). A reading costs microseconds, so this adds well under a
 * microsecond a call.
 *
 * On its own a call count bounds nothing: it is only as good as the worst
 * single call. One call retained 25 MB — six member tables of 32,000 names —
 * and the process aborted at call 144, before the second reading (PR #1104
 * review cycle 6; the 28 MB this comment used to give assumed 111 KB a call).
 * What the heap may pass the limit by is bounded by
 * {@link GO_BINDING_HEAP_SAMPLE_ENTRIES}, not by this.
 */
export const GO_BINDING_HEAP_SAMPLE_CALLS = 256;

/**
 * #1071 — the heap is ALSO read whenever the resolver has kept this many more
 * entries than at the last reading (`GoResolver.retainedTotal`, a running
 * sum: one comparison a call). So a reading cannot be outrun by calls that
 * each keep a lot: between two readings the resolver adds fewer than this
 * many entries plus what ONE call adds.
 *
 * The overshoot — what the heap may have grown past the limit when a reading
 * notices — therefore has two parts, and only the first is a constant:
 *
 *  - about 8 MB: 16,384 entries are 0.4 to 2 MB at the 23 to 130 B an entry
 *    measured at 24,000 types (4 MB at the 250 B of a small tree), and one
 *    call's member tables are at most 1.5 MB (`GO_TYPE_RETAINED_MAX`);
 *  - what ONE call's first reading of the declarations it reaches keeps: 40
 *    to 50 B a declared member, once per declaration. No reading can come
 *    between them, so this is bounded by the members those declarations
 *    declare and by nothing smaller — linear in the source the call reaches,
 *    about 6 retained bytes per byte of Go. One call through 61 types of
 *    20,000 fields (17.5 MB of Go) kept 54 MB against a 16 MB limit (PR #1104
 *    review cycle 7; this comment used to give "at most about 8 MB" as the
 *    ceiling). The reading after that call sees it and stops the step.
 *
 * At the 512 MB default the second term is not an abort: it takes tens of
 * megabytes of Go behind a single call to come near it.
 *
 * Reading the heap before EVERY call was measured and rejected: on Miniflux
 * (21,106 calls, 5.6 ms of resolving) it adds 16 ms, nearly three times the
 * step. This rule costs nothing measurable there — the same 83 readings as
 * the count alone, the difference inside run-to-run noise.
 */
export const GO_BINDING_HEAP_SAMPLE_ENTRIES = 16_384;

/**
 * The default for {@link IngestOptions.goBindingMaxHeapGrowth}:
 * {@link GO_BINDING_MAX_HEAP_GROWTH}, or a quarter of the process's heap limit
 * where that is less — a server started with `--max-old-space-size=1024`
 * would otherwise abort before a 512 MB watchdog ever tripped.
 */
export function defaultGoBindingHeapLimit(
  heapSizeLimit: number = getHeapStatistics().heap_size_limit,
): number {
  return Math.min(GO_BINDING_MAX_HEAP_GROWTH, Math.floor(heapSizeLimit / 4));
}

/**
 * #1071 — the ingests a graph may END with Go binding still open, over and
 * above the number the floor itself needs.
 *
 * Every ingest resolves at least {@link GO_BINDING_MIN_CALLS} of the calls
 * still open, and takes them up where the last one stopped whatever else
 * changed. So N open calls are closed within ⌈N / GO_BINDING_MIN_CALLS⌉
 * ingests — unless an ingest closes none, which happens only when it cannot
 * read the file or cannot build a resolver at all. Three such ingests are
 * allowed for (a file locked for one run, a checkout caught mid-write). A graph
 * still open after that is not slow, it is stuck, and waiting longer would
 * leave it unstamped — and every auto-updating document that reads it
 * acknowledging its changes as an upgrade — for good. So the bound is counted
 * in ingests, not in days: an ingest is the only thing that can make progress.
 *
 * The allowance is worked out when work is first left open, and AGAIN by every
 * ingest that re-plans it: a change to a Go file puts every unchanged Go file
 * back on the list from its first call, so counting on down from a number
 * sized for what was open before would give an active repository up early.
 * It is not renewed while the calls NEVER resolved by type stand still — no
 * file of them advanced — since that is the stuck graph this bound is for.
 *
 * When it runs out the remainder is ABANDONED: moved to
 * {@link GoBindingIncomplete.abandoned}, no longer resumed, and the graph is
 * stamped. What an abandoned call holds from then on, exactly:
 *
 *  - a call NEVER resolved by type (`files`) holds what it held: the
 *    name-evidence answer (labelled `name`, or unbound with no label), or on
 *    a graph an older extractor wrote the row that extractor left;
 *  - a call waiting to be resolved AGAIN (`again`) held a TYPE answer worked
 *    out before the last change to a Go file — possibly a binding, labelled
 *    `receiver-type` or `package`, to a function the change moved the call
 *    away from. That answer is not kept: at the moment of abandonment the
 *    call is written undecided by type — the name-evidence answer, like any
 *    call the resolver could not decide — or, in a file this ingest could not
 *    read, unbound with no label.
 *
 * So no abandoned call carries a type verdict older than the tree it is in.
 * It stays that way until its file changes or a later change to any Go file
 * binds the whole tree again.
 */
export const GO_BINDING_RESUME_GRACE = 3;

/**
 * #1071 — `CodeGraph.goBindingIncomplete`: the Go binding an ingest did not
 * finish.
 *
 * `files` maps a file to the index, among that file's Go call edges in source
 * order, of the first call NEVER resolved by type on the rows the graph holds;
 * every call before it was. (Once the ceiling is reached every later call is
 * skipped, so what is left of a file is always its tail.) These are resumed
 * FIRST by every later ingest, each from its recorded index — also when
 * another Go file changed in between, so that an actively developed
 * repository still finishes — and the graph's version is not stamped while
 * one is left.
 *
 * `again` maps a file to the first call whose stored answer was resolved
 * BEFORE the last change to a Go file and has not been re-resolved since: a Go
 * call binds through declarations anywhere in the tree, so a change re-binds
 * every unchanged file, and this is what the ceiling left of that. Such a call
 * keeps the answer it has until its turn comes. It restarts at 0 for every file
 * whenever a Go file changes, and does not hold the version back.
 *
 * `inFlight` is written BEFORE the first row of an ingest in which a Go file
 * changed or was deleted, and removed by the write that ends it. An ingest
 * that stops in between — a crash, a throw in a later step — has stored the
 * new content hash of the changed file, and may have stored name-evidence
 * answers for the calls its ceiling skipped, with nothing else to say so: the
 * next ingest would find no changed file and resume nothing. With the flag it
 * re-binds every Go file. (No other ingest needs it: one that only resumes
 * leaves its record standing until Step 8 replaces it, an upgrade leaves the
 * version unstamped, and a re-bind no Go change caused decides nothing anew.)
 *
 * `resumesLeft` and `abandoned`: {@link GO_BINDING_RESUME_GRACE}.
 *
 * `version` is the extractor version the graph's ROWS already have: an upgrade
 * the ceiling interrupted has renamed every symbol and rewritten every edge,
 * so it is resumed, not started again — although
 * `CodeGraph.extractorVersion` is stamped only once `files` is empty.
 */
export interface GoBindingIncomplete {
  version: number;
  files: Record<string, number>;
  again?: Record<string, number>;
  inFlight?: true;
  resumesLeft?: number;
  abandoned?: Record<string, number>;
}

/** {@link GoBindingIncomplete} as read back: every part present, empty where nothing was recorded. */
export interface GoBindingRecord {
  files: Map<string, number>;
  again: Map<string, number>;
  inFlight: boolean;
  /** Null when no ingest has ended with work open yet. */
  resumesLeft: number | null;
  abandoned: Map<string, number>;
}

const callIndices = (stored: unknown): Map<string, number> => {
  const out = new Map<string, number>();
  if (!stored || typeof stored !== "object") return out;
  for (const [file, index] of Object.entries(stored)) {
    if (typeof index === "number" && Number.isInteger(index) && index >= 0) out.set(file, index);
  }
  return out;
};

/**
 * `CodeGraph.goBindingIncomplete`, read whole. Anything unreadable, or written
 * for another extractor version, is "nothing recorded": the worst that costs
 * is the old behaviour, an upgrade or a re-bind from the start.
 */
export function readGoBindingIncomplete(stored: string | null | undefined): GoBindingRecord {
  const none: GoBindingRecord = {
    files: new Map(),
    again: new Map(),
    inFlight: false,
    resumesLeft: null,
    abandoned: new Map(),
  };
  if (!stored) return none;
  try {
    const parsed = JSON.parse(stored) as Partial<GoBindingIncomplete> | null;
    if (!parsed || parsed.version !== CODE_GRAPH_EXTRACTOR_VERSION) return none;
    return {
      files: callIndices(parsed.files),
      again: callIndices(parsed.again),
      inFlight: parsed.inFlight === true,
      resumesLeft:
        typeof parsed.resumesLeft === "number" && Number.isInteger(parsed.resumesLeft)
          ? parsed.resumesLeft
          : null,
      abandoned: callIndices(parsed.abandoned),
    };
  } catch {
    // A corrupt value is nothing recorded.
    return none;
  }
}

/** The stored form of a record; null when it holds nothing. Empty parts are left out. */
function writeGoBindingIncomplete(record: GoBindingRecord): string | null {
  if (record.files.size + record.again.size + record.abandoned.size === 0 && !record.inFlight) {
    return null;
  }
  return JSON.stringify({
    version: CODE_GRAPH_EXTRACTOR_VERSION,
    files: Object.fromEntries(record.files),
    ...(record.again.size > 0 ? { again: Object.fromEntries(record.again) } : {}),
    ...(record.inFlight ? { inFlight: true as const } : {}),
    ...(record.resumesLeft !== null ? { resumesLeft: record.resumesLeft } : {}),
    ...(record.abandoned.size > 0 ? { abandoned: Object.fromEntries(record.abandoned) } : {}),
  } satisfies GoBindingIncomplete);
}

/**
 * The files `CodeGraph.goBindingIncomplete` lists as never resolved by type
 * ({@link GoBindingIncomplete.files}) and where each resumes.
 */
export function parseGoBindingIncomplete(stored: string | null | undefined): Map<string, number> {
  return readGoBindingIncomplete(stored).files;
}

/** Bytes of a `go.mod` read for its `module` line, which sits at the top. */
const GO_MOD_READ_LIMIT = 64 * 1024;

/**
 * #721 — fingerprint of the inputs that decide what the SQL-lineage pass
 * (Step 6) writes for a file: whether lineage is enabled and, when it is, the
 * extractor version and the introspected schema. With lineage off nothing is
 * written, so neither is included — adding a DB connector or upgrading the
 * extractor then does not force a re-parse. Schema keys are sorted, so the same
 * schema introspected in another order hashes the same.
 *
 * Format: `off` | `<on|unreached>:v<version>:<schemaHash>`.
 */
export function lineageFingerprint(
  lineageEnabled: boolean,
  schema: IntrospectedSchema | null | undefined,
  opts: {
    /** A stored schema component to keep instead of hashing `schema` — the
     *  connector could not be introspected, so `schema` says nothing. */
    preservedSchema?: string;
    /** Lineage was on but the sidecar never answered: record `unreached`. */
    sidecarUnreached?: boolean;
  } = {},
): string {
  if (!lineageEnabled) return "off";
  const schemaPart = opts.preservedSchema ?? schemaFingerprint(schema);
  const state = opts.sidecarUnreached ? "unreached" : "on";
  return `${state}:v${LINEAGE_EXTRACTOR_VERSION}:${schemaPart}`;
}

/** The schema component of a {@link lineageFingerprint}. */
function schemaFingerprint(schema: IntrospectedSchema | null | undefined): string {
  const sortKeys = (v: unknown): unknown =>
    v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
        )
      : v;
  return sha256(JSON.stringify(sortKeys(schema ?? null)));
}

/**
 * #721 — split a stored fingerprint. `on:…` means lineage ran against that
 * schema; `unreached:…` means lineage was on but the sidecar could not be
 * reached, so no file got lineage and the next reachable run must backfill.
 * `off` and a pre-#721 `null` carry no schema component. The `v<n>:` segment
 * is optional so a pre-#807 `on:<schema>` still yields its schema part (kept
 * across an introspection outage); its missing version alone forces the
 * backfill, through the string comparison in {@link ingestCodeGraph}.
 */
function parseLineageFingerprint(
  stored: string | null,
): { state: "on" | "unreached"; schema: string } | null {
  const m = /^(on|unreached):(?:v\d+:)?([^:]+)$/.exec(stored ?? "");
  return m ? { state: m[1] as "on" | "unreached", schema: m[2] } : null;
}

export async function ingestCodeGraph(
  prisma: PrismaClient,
  options: IngestOptions,
): Promise<IngestStats> {
  const start = Date.now();
  const { projectId, rootDir, repoConnectionId, commitSha, incremental = true } = options;

  // Issue #322 — initialise web-tree-sitter once per process. Idempotent and
  // cheap on the second call (returns the cached parsers).
  await initCodeGraphParsers();

  // Issue #16 — every long loop below calls this once per unit of work so the
  // event loop (and `/healthz`) gets a turn at least every ~50 ms. Without it,
  // the synchronous SQLite adapter keeps the whole persist phase on the
  // microtask queue and the API goes dark for the length of the ingest.
  const maybeYield = createEventLoopYielder();

  // Step 1 — locate or create the CodeGraph row.
  const graph = await upsertCodeGraph(prisma, projectId, repoConnectionId);

  // #721 — Step 6 runs only over re-parsed files, so an incremental run whose
  // lineage inputs changed would leave every unchanged file without lineage.
  // Re-parse everything when they differ. A graph built before #721 has no
  // fingerprint: re-parse once if lineage is on now, since it may predate it.
  //
  // A connector that could not be introspected says nothing about the schema,
  // so keep the stored schema component rather than fingerprinting "no schema".
  const lineageOn = isSqlLineageEnabled(options.sqlLineageOverride);
  const stored = parseLineageFingerprint(graph.lineageFingerprint);
  const preservedSchema = options.introspectionFailed ? stored?.schema : undefined;
  const fingerprint = lineageFingerprint(lineageOn, options.introspectedSchema, {
    preservedSchema,
  });

  // Step 2 — load .metisignore (file or default).
  const metisignorePath = path.join(rootDir, ".metisignore");
  let ignoreContent = DEFAULT_METISIGNORE;
  try {
    ignoreContent = await fs.readFile(metisignorePath, "utf8");
  } catch {
    // File missing — use defaults. NOT a hard error.
  }
  const ignoreRules = compileMetisignore(ignoreContent);

  // Step 3 — load the graph's existing files: their hashes drive the
  // incremental skip, and a file no longer in the tree is pruned (#313).
  const existingFiles = await loadExistingFiles(prisma, graph.id);
  let lineageBackfill =
    incremental && existingFiles.size > 0 && (graph.lineageFingerprint ?? "off") !== fingerprint;
  // The last run had lineage on but no sidecar. Re-parsing everything against a
  // sidecar that is still down would write nothing, so check it answers first.
  let sidecarStillDown = false;
  if (lineageBackfill && lineageOn && stored?.state === "unreached") {
    sidecarStillDown = !(await probeSqlLineageSidecar());
    if (sidecarStillDown) lineageBackfill = false;
  }

  // #1071 — the languages whose unchanged files an older extractor wrote. A
  // full re-ingest rewrites every row anyway.
  //
  // A graph whose Go binding the time ceiling interrupted says so
  // (`goBindingIncomplete`): which files are still open, and that its rows
  // already have the current shape — so an interrupted upgrade is resumed, and
  // not started again only to be interrupted at the same place.
  const goBindingRecord = readGoBindingIncomplete(incremental ? graph.goBindingIncomplete : null);
  const goBindingPending = goBindingRecord.files;
  const rowsVersion =
    goBindingPending.size > 0 ? CODE_GRAPH_EXTRACTOR_VERSION : graph.extractorVersion;
  const upgradeLanguages = incremental ? extractorUpgradeLanguages(rowsVersion) : new Set<string>();
  // #1072 — the graph's unchanged files were written before the symbol context
  // columns existed (or by an older extractor of them). A full re-ingest
  // rewrites every row anyway, and a graph with no files has nothing to fill.
  const contextBackfill =
    incremental &&
    existingFiles.size > 0 &&
    (graph.symbolContextVersion ?? 0) < SYMBOL_CONTEXT_VERSION;
  // Files of the graph the backfill could not read: while there is one, the
  // version is not recorded and the next ingest tries again.
  let contextBackfillFailed = 0;
  // What this run leaves open in turn; written back in Step 8.
  const goBindingLeft = new Map<string, number>();
  const goBindingAgainLeft = new Map<string, number>();
  const goBindingAbandoned = new Map(goBindingRecord.abandoned);
  // What `persistParsed` decided about the allowance; written back in Step 8.
  const goBindingEnd: GoBindingEnd = { resumesLeft: null, abandonedNow: [] };
  // #1071 — said BEFORE the first row that depends on it: a Go file changed,
  // and until Step 8 replaces the record nobody can vouch for the rows this
  // ingest is writing ({@link GoBindingIncomplete.inFlight}).
  let goBindingMarked = false;
  const markGoBindingInFlight = async (): Promise<void> => {
    if (goBindingMarked) return;
    goBindingMarked = true;
    await prisma.codeGraph.update({
      where: { id: graph.id },
      data: {
        goBindingIncomplete: writeGoBindingIncomplete({ ...goBindingRecord, inFlight: true }),
      },
    });
  };
  // #1071 — files an earlier upgrade could not reach, with the hash of the
  // content that failed. A full re-ingest starts clean.
  const rememberedFailures = incremental
    ? parseUpgradeFailures(graph.extractorUpgradeFailed)
    : new Map<string, string | null>();
  // What this run leaves un-upgraded: path → the hash of the content that
  // failed (null: unreadable). Written back in Step 8.
  const upgradeFailures = new Map<string, string | null>();
  // Remembered files whose content is no longer the one that failed: retried.
  const upgradeRetryPaths = new Set<string>();
  // #1071 — `CodeGraph.extractorUpgradedAt` for each write of an upgrade
  // rewrite: strictly increasing, so a reader that saw one write and then
  // another can always tell the mark moved.
  let lastUpgradeMark = 0;
  const nextUpgradeMark = (): Date => {
    lastUpgradeMark = Math.max(Date.now(), lastUpgradeMark + 1);
    return new Date(lastUpgradeMark);
  };

  // Step 4 — walk the tree.
  const stats: IngestStats = {
    codeGraphId: graph.id,
    filesScanned: 0,
    filesParsed: 0,
    filesSkipped: 0,
    symbolsUpserted: 0,
    edgesUpserted: 0,
    rationaleFindings: 0,
    schemaEdges: 0,
    routineEdges: 0,
    filesRebound: 0,
    filesUpgraded: 0,
    filesUpgradeFailed: [],
    filesUpgradeFailedCount: 0,
    filesUnparseable: [],
    filesUnparseableCount: 0,
    goBinding: null,
    lineageBackfill,
    filesLineageRefreshed: 0,
    filesUnchanged: 0,
    graphFiles: 0,
    graphSymbols: 0,
    graphEdges: 0,
    languageStats: {},
    durationMs: 0,
  };

  const parsedFiles: ParsedFile[] = [];
  // Retain raw source per parsed file (keyed by relPath) so the SQL-lineage
  // extractors (#305/#306) can re-scan string literals / PROC SQL blocks after
  // parsing. ParsedFile intentionally does not carry the full source.
  const sourceByRelPath = new Map<string, string>();
  // #849 — ORM model files (Prisma `schema.prisma`, JPA entities) mapped to their
  // source for the ORM schema-extraction pass. `.prisma` is not a tree-sitter
  // language so it is captured here; JPA `.java` is captured after it parses.
  const ormSources = new Map<string, string>();
  // #884 — MyBatis mapper files (XML `<mapper>` + `.java` `@Select`/`@Insert`/
  // `@Update`/`@Delete` annotation interfaces) mapped to their source for the
  // MyBatis schema-extraction pass. `.xml` is not a tree-sitter language so it is
  // captured here (mirroring `.prisma`); annotation `.java` is captured after it
  // parses (mirroring JPA `.java`).
  const myBatisSources = new Map<string, string>();
  // #897 — jOOQ generated table classes (`.java`, always a tree-sitter
  // language) mapped to their source for the jOOQ table-class lineage pass.
  // Captured after parsing (mirroring the JPA/MyBatis `.java` capture below);
  // `extractJooqTableClasses` itself gates on `extends TableImpl` presence,
  // so an unrelated `.java` file yields zero table classes and zero edges —
  // capturing it here unconditionally is harmless.
  const jooqSources = new Map<string, string>();
  // #898 — Python sources (`.py`, always a tree-sitter language) mapped to their
  // source for the SQLAlchemy Core/ORM query-lineage pass. Captured after
  // parsing (mirroring the jOOQ `.java` capture below); the SQLAlchemy resolver
  // itself gates on `__tablename__`/`Table(`/`Column(` presence, so a plain
  // `.py` file with no SQLAlchemy declarations yields zero entities and zero
  // edges — capturing it here unconditionally is harmless.
  const pySources = new Map<string, string>();
  // #899 — Go source (`.go`, always a tree-sitter language) mapped to its
  // source for the GORM model→physical-table lineage pass (Step 5x). Captured
  // after parsing (mirroring the jOOQ `.java` capture below);
  // `buildGormEntityResolver`/`findGormCallSites` themselves gate on
  // `struct {` / GORM finisher verbs, so a non-GORM `.go` file yields zero
  // models and zero edges — capturing it here unconditionally is harmless.
  const goSources = new Map<string, string>();
  // #1071 — `go.mod` files: the module path is what tells a project package
  // from a third-party one of the same directory name.
  const goModules: GoModule[] = [];
  // #1071 — Go files the walk met and could not read or parse: the resolver
  // must not rule out a name their package may declare.
  const unparsedGoPaths: string[] = [];
  // #900 — C#/.NET source files (`.cs`) mapped to their source for the EF Core
  // lineage pass. Captured after parsing (mirroring the JPA/jOOQ `.java`
  // capture below); `extractEfCoreSchema` itself gates on the presence of a
  // resolvable `DbSet<T>`, so an unrelated `.cs` file yields zero edges.
  const csSources = new Map<string, string>();
  // #313 — every path the walk saw, and the files it skipped as unchanged: pass 2
  // resolves edges against the whole tree, not only the files re-parsed.
  const walkedPaths = new Set<string>();
  const unchangedFiles = new Map<string, { language: string; contentHash: string }>();
  // #856 — on a lineage backfill an unchanged file is NOT re-parsed: re-creating
  // its symbols would give them new ids and unlink every finding, mapping and
  // embedding that pointed at the old ones (#706 run 3 lost them on a same-SHA
  // refresh). Only its lineage (Step 6) depends on the changed inputs, so only
  // that is redone; these carry what Step 6 reads — path, language and source.
  const lineageOnlyFiles: ParsedFile[] = [];
  const lineageOnlySources = new Map<string, string>();
  // #1071 — a Go file the ignore rules hide (`*_gen.go`, `*.pb.go`) is still
  // part of its directory's package: the resolver must know it did not read it.
  const onIgnoredFile = (relPath: string): void => {
    if (detectLanguage(relPath) === "go") unparsedGoPaths.push(relPath);
  };
  for await (const filePath of walkTree(rootDir, ignoreRules, onIgnoredFile)) {
    stats.filesScanned += 1;
    walkedPaths.add(path.relative(rootDir, filePath).split(path.sep).join("/"));
    const lang = detectLanguage(filePath);
    if (!lang) {
      if (path.basename(filePath) === "go.mod") {
        const goModule = await readGoModule(rootDir, filePath);
        if (goModule) goModules.push(goModule);
      }
      // ORM schema files (`schema.prisma`) are not a tree-sitter language but still
      // map to tables/columns — capture their source for the ORM pass (#849). Always
      // read (no persisted hash exists) so an existing graph populates on next ingest.
      if (isOrmSchemaFile(filePath)) {
        const relPath = path.relative(rootDir, filePath).split(path.sep).join("/");
        try {
          ormSources.set(relPath, stripNulBytes(await fs.readFile(filePath, "utf8")));
        } catch {
          // Unreadable ORM file — skip; ORM extraction degrades gracefully.
        }
      }
      // MyBatis XML mappers (`.xml`) are likewise not a tree-sitter language but
      // still map to tables/columns — capture their source for the MyBatis pass
      // (#884). `extractMyBatis` itself gates on the `<mapper>` tag, so a
      // non-mapper `.xml` file (pom.xml, web.xml, ...) simply yields zero
      // statements and zero edges — reading it here is harmless.
      if (isMyBatisXmlFile(filePath)) {
        const relPath = path.relative(rootDir, filePath).split(path.sep).join("/");
        try {
          myBatisSources.set(relPath, stripNulBytes(await fs.readFile(filePath, "utf8")));
        } catch {
          // Unreadable MyBatis mapper — skip; MyBatis extraction degrades gracefully.
        }
      }
      stats.filesSkipped += 1;
      continue;
    }
    const relPath = path.relative(rootDir, filePath).split(path.sep).join("/");
    let source: string;
    try {
      source = stripNulBytes(await fs.readFile(filePath, "utf8"));
    } catch {
      stats.filesSkipped += 1;
      if (lang === "go") unparsedGoPaths.push(relPath);
      // #1072 — nor can its symbols be given their context from a file nobody can read.
      if (contextBackfill && existingFiles.has(relPath)) contextBackfillFailed += 1;
      // Rows the graph holds for it cannot be brought to the current shape (#1071).
      if (
        existingFiles.has(relPath) &&
        (upgradeLanguages.has(lang) || rememberedFailures.has(relPath))
      ) {
        noteUpgradeFailed(stats, upgradeFailures, relPath, null);
      }
      continue;
    }
    const fileHash = sha256(source);
    const existing = existingFiles.get(relPath);
    if (incremental && existing?.contentHash === fileHash) {
      unchangedFiles.set(relPath, { language: existing.language, contentHash: fileHash });
      if (rememberedFailures.has(relPath) && !upgradeLanguages.has(lang)) {
        // Same content as the one that failed: it would fail again. Anything
        // else (it was unreadable then) is worth one more try.
        if (rememberedFailures.get(relPath) === fileHash) {
          noteUpgradeFailed(stats, upgradeFailures, relPath, fileHash);
        } else upgradeRetryPaths.add(relPath);
      }
      stats.filesSkipped += 1;
      stats.filesUnchanged += 1;
      if (lineageBackfill && (EMBEDDED_SQL_LANGUAGES.has(lang) || lang === "sas")) {
        lineageOnlyFiles.push({
          filePath: relPath,
          language: lang,
          symbols: [],
          edges: [],
          fileHash,
          rationaleHints: [],
        });
        lineageOnlySources.set(relPath, source);
        stats.filesLineageRefreshed += 1;
      }
      continue;
    }
    await maybeYield();
    const parsed = parseSource(relPath, source, lang);
    if (parsed.unparseable) {
      stats.filesSkipped += 1;
      noteUnparseable(stats, relPath);
      if (lang === "go") unparsedGoPaths.push(relPath);
      // Rows the graph already holds for it stay as an older extractor wrote
      // them (#1071): remembered, and tried again when the content changes.
      if (existing && (upgradeLanguages.has(lang) || rememberedFailures.has(relPath))) {
        noteUpgradeFailed(stats, upgradeFailures, relPath, fileHash);
      }
      continue;
    }
    parsedFiles.push(parsed);
    sourceByRelPath.set(relPath, source);
    // #849 — JPA entity files (`.java`) also feed the ORM schema pass. persistParsed
    // wipes+repopulates these paths, so the ORM pass re-adds their schema symbols.
    if (lang === "java") ormSources.set(relPath, source);
    // #884 — `.java` files also feed the MyBatis annotation-mapper pass;
    // `extractMyBatis` itself gates on `@Select`/`@Insert`/`@Update`/`@Delete`
    // presence, so a plain JPA entity or unrelated `.java` file yields zero
    // statements and zero edges — capturing it here unconditionally is harmless.
    if (lang === "java") myBatisSources.set(relPath, source);
    // #897 — `.java` files also feed the jOOQ generated-table-class pass.
    if (lang === "java") jooqSources.set(relPath, source);
    // #898 — `.py` files feed the SQLAlchemy Core/ORM query-lineage pass.
    if (lang === "py") pySources.set(relPath, source);
    // #899 — `.go` files feed the GORM model→table lineage pass (Step 5x).
    if (lang === "go") goSources.set(relPath, source);
    // #900 — `.cs` files also feed the EF Core lineage pass.
    if (lang === "cs") csSources.set(relPath, source);
    stats.filesParsed += 1;
    stats.languageStats[lang] = (stats.languageStats[lang] ?? 0) + parsed.symbols.length;
  }

  // Step 5 — persist. Wipe previous rows for files we re-parsed so we don't
  // accumulate stale symbols. (For unchanged files the previous rows remain.)
  await persistParsed(
    prisma,
    graph.id,
    projectId,
    parsedFiles,
    stats,
    sourceByRelPath,
    maybeYield,
    {
      rootDir,
      unchangedFiles,
      previousPaths: new Set(existingFiles.keys()),
      deletedPaths: [...existingFiles.keys()].filter((p) => !walkedPaths.has(p)),
      goModules,
      unparsedGoPaths,
      upgradeLanguages,
      upgradeRetryPaths,
      upgradeFailures,
      nextUpgradeMark,
      goBindingMaxMs: options.goBindingMaxMs ?? GO_BINDING_MAX_MS,
      goBindingMinCalls: options.goBindingMinCalls ?? GO_BINDING_MIN_CALLS,
      goBindingNow: options.goBindingNow ?? (() => performance.now()),
      goBindingMaxHeapGrowth: options.goBindingMaxHeapGrowth ?? defaultGoBindingHeapLimit(),
      goBindingHeapUsed: options.goBindingHeapUsed ?? (() => process.memoryUsage().heapUsed),
      goBindingResumesLeft: goBindingRecord.resumesLeft,
      goBindingEnd,
      goBindingPending,
      goBindingAgain: goBindingRecord.again,
      goBindingInterrupted: goBindingRecord.inFlight,
      goBindingLeft,
      goBindingAgainLeft,
      goBindingAbandoned,
      markGoBindingInFlight,
      // The version was never stamped: the calls an earlier run never resolved,
      // re-bound in place now (only a resume does that; the upgrade itself
      // rewrites them whole), are the rest of an extractor upgrade.
      goBindingResumesUpgrade: extractorUpgradeLanguages(graph.extractorVersion).has("go"),
    },
  );

  // Step 5b — ORM schema extraction (#849). Map ORM model definitions (Prisma
  // `schema.prisma`, JPA entities) onto `table`/`column` symbols + `persists-to`
  // edges. Pure static parsing (no sidecar, no live DB), so unlike extractSchemaUsage
  // it runs on EVERY ingest — the schema graph then exists for ORM projects out of
  // the box, which is what the DB-impact analysis (#820) consumes. Never throws.
  await extractOrmSchema(
    prisma,
    graph.id,
    projectId,
    ormSources,
    parsedFiles,
    stats,
    sourceByRelPath,
  );

  // Step 5b2 — JPA query-lineage extraction (#896). Resolves HQL/JPQL @Query
  // annotations and Spring Data derived-query methods on repository
  // interfaces to the physical table/column their entity maps onto, via the
  // framework-agnostic EntityTableResolver. Runs on every ingest, right after
  // extractOrmSchema so entity tables it just created are already prewarmed.
  // Pure static parsing (no sidecar, no live DB). Never throws.
  await extractJpaQuerySchema(prisma, graph.id, projectId, ormSources, stats);

  // Step 5c — MyBatis schema extraction (#884). Map MyBatis XML mappers and
  // `@Select`/`@Insert`/`@Update`/`@Delete` annotation interfaces onto
  // `table`/`column` symbols + `reads`/`writes`/`persists-to` edges. Pure static
  // parsing (no sidecar, no live DB) — like the ORM pass above, and unlike
  // extractSchemaUsage below, it runs on EVERY ingest so MyBatis projects get a
  // populated schema graph out of the box. Runs AFTER extractOrmSchema so its
  // fresh table/column prewarm query picks up any tables the ORM pass just
  // created, keeping the two extractors from forking the same physical table
  // into two symbol rows. Never throws.
  await extractMyBatisSchema(prisma, graph.id, projectId, myBatisSources, parsedFiles, stats);

  // Step 5d — jOOQ generated table-class lineage (#897, Epic #883). jOOQ maps
  // physical tables onto GENERATED Java table classes referenced fluently in
  // `DSLContext` queries (`.select(...).from(BOOK)`). This is symbol
  // resolution, not SQL parsing — resolve the constant to its physical table,
  // then anchor `reads`/`writes` edges to the REAL enclosing code symbol
  // (mirrors the #872 ORM call-site pattern). Independent of the #896
  // entity->table resolver: a generated jOOQ table class is a query-builder
  // handle, not a user-authored persistence declaration, so — unlike
  // ORM/MyBatis — no edge is emitted for a class no application code queries.
  // Pure static parsing (no sidecar, no live DB) — runs on EVERY ingest.
  // Never throws.
  await extractJooqSchema(
    prisma,
    graph.id,
    projectId,
    jooqSources,
    parsedFiles,
    stats,
    sourceByRelPath,
  );

  // Step 5e — SQLAlchemy Core & ORM query-lineage (#898, Epic #883). Resolves
  // `session.query(User)` / `select(users)` / `orders.insert()` call sites to
  // the physical table their mapped class / Core `Table` variable declares, via
  // the framework-agnostic EntityTableResolver (#896), and anchors
  // `reads`/`writes` edges to the REAL enclosing Python function symbol (mirrors
  // the #897 jOOQ call-site pattern). Raw psycopg string SQL is NOT handled here
  // — it already rides the sqlglot sidecar path in extractSchemaUsage (Step 6).
  // Pure static parsing (no sidecar, no live DB) — runs on EVERY ingest. Never
  // throws.
  await extractSqlAlchemySchema(
    prisma,
    graph.id,
    projectId,
    pySources,
    parsedFiles,
    stats,
    sourceByRelPath,
  );

  // Step 5x — Go GORM model→physical-table lineage (#899, Epic #883). GORM is a
  // Go ORM: application code references a struct (`db.Model(&User{}).Find(...)`),
  // never a physical table name. This pass parses GORM model structs into the
  // framework-agnostic EntityTableResolver (#896, reused via
  // buildGormEntityResolver) and anchors `reads`/`writes` edges (source "orm")
  // from the REAL enclosing Go function symbol to the resolved table — mirrors
  // the #872 ORM / #897 jOOQ call-site pattern. Pure static parsing (no sidecar,
  // no live DB), so — like the ORM/MyBatis/jOOQ passes — it runs on EVERY
  // ingest, NOT gated on SQL_LINEAGE_MODE. Go raw-SQL strings
  // (database/sql/sqlx) stay on the sqlglot embedded-SQL path (Step 6). Never
  // throws.
  await extractGoSchema(
    prisma,
    graph.id,
    projectId,
    goSources,
    parsedFiles,
    stats,
    sourceByRelPath,
  );

  // Step 5f — EF Core lineage (#900, Epic #883). Resolves C# entity classes to
  // physical tables (via the framework-agnostic EntityTableResolver, reused
  // from #896) and scans the SAME `.cs` files for `DbSet<T>` LINQ call sites
  // (`context.Customers.Where(...)`, `.Add(...)`), emitting `reads`/`writes`
  // edges from the REAL enclosing code symbol — the .NET analogue of the #872
  // Prisma / #897 jOOQ call-site passes. Pure static parsing (no sidecar, no
  // live DB) — runs on EVERY ingest. C# ADO.NET/Dapper raw SQL is separate: it
  // rides the sidecar-gated embedded-SQL path in Step 6. Never throws.
  await extractEfCoreSchema(prisma, graph.id, projectId, csSources, parsedFiles, stats);

  // Step 6 — extract embedded-SQL / SAS PROC SQL usage into the schema graph
  // (#305/#306), plus routine `executes` (code→routine) and `calls`
  // (routine→object) edges (#316), feeding the introspected schema (#317).
  // Feature-gated on SQL_LINEAGE_MODE and degrades gracefully when the sidecar is
  // absent — never throws, never blocks ingest.
  //
  // #856 — on a lineage backfill the unchanged files join this step only: their
  // previous lineage rows are cleared first (a re-parsed file's went with its
  // other rows in Step 5), and the writer reuses the persisted table/column ids.
  const lineagePaths = lineageOnlyFiles.map((f) => f.filePath);
  if (lineagePaths.length > 0) await clearFileLineage(prisma, graph.id, lineagePaths);
  const lineageFiles =
    lineagePaths.length > 0 ? [...parsedFiles, ...lineageOnlyFiles] : parsedFiles;
  const lineageSources =
    lineagePaths.length > 0
      ? new Map([...sourceByRelPath, ...lineageOnlySources])
      : sourceByRelPath;
  const { reachability } = await trackSqlLineageReachability(() =>
    extractSchemaUsage(prisma, graph.id, projectId, lineageFiles, lineageSources, stats, {
      lineageRefreshPaths: new Set(lineagePaths),
      schema: options.introspectedSchema ?? null,
      routines: options.routines,
      fetchRoutineBody: options.fetchRoutineBody,
      routineDialect: options.routineDialect,
      packages: options.packages,
      fetchPackageBody: options.fetchPackageBody,
      dependencies: options.dependencies,
      sqlLineageOverride: options.sqlLineageOverride,
    }),
  );
  if (lineagePaths.length > 0) await pruneOrphanLineageSymbols(prisma, graph.id, lineagePaths);

  // #721 — record lineage as "on" only if the sidecar actually served this run
  // (or nothing needed it). If every call failed, or a due backfill was skipped
  // because the sidecar was still down, record `unreached` so the next run with
  // a reachable sidecar re-parses everything.
  const sidecarUnreached =
    lineageOn && (sidecarStillDown || (reachability.unreachable > 0 && reachability.reached === 0));
  const recordedFingerprint = sidecarUnreached
    ? lineageFingerprint(lineageOn, options.introspectedSchema, {
        preservedSchema,
        sidecarUnreached,
      })
    : fingerprint;

  // Step 6.5 — reconcile the project's schema graph into canonical cross-project
  // SchemaObjectIdentity rows (#955). The identity service (#308) shipped with
  // ZERO production callers, so identities were never created and every
  // identity-gated cross-project query (#309 whichProjectsUseObject, #822
  // enumerateSchemaConsumers) was permanently unresolved. Wiring it HERE — after
  // every schema-graph pass has written its `table`/routine symbols — means an
  // auto-linked connection populates identities on its next ingest. Idempotent,
  // read-only against the customer DB (touches only METIS's own tables), and
  // self-gates to projects with exactly one linked DatabaseResource. Best-effort:
  // a reconcile failure must never fail the ingest that produced the symbols.
  try {
    await reconcileProjectSchemaIdentities(projectId, prisma);
  } catch {
    // Best-effort: a cross-project identity reconcile failure must never fail the
    // ingest that produced the symbols (mirrors the schema passes' never-throw
    // contract). The next ingest re-attempts it idempotently.
  }

  // Step 7 — extract rationale and (optionally) persist as Findings.
  await persistRationale(
    prisma,
    projectId,
    parsedFiles,
    stats,
    options.triggeredByUserId,
    maybeYield,
  );

  // Step 7b (#1072) — give the symbols of every UNCHANGED file their context
  // columns, on the existing rows. After the passes above on purpose: an
  // extractor upgrade may have just renamed a row, and the receiver is read off
  // the name.
  if (contextBackfill) {
    const filled = await backfillSymbolContext(
      prisma,
      graph.id,
      rootDir,
      unchangedFiles,
      maybeYield,
    );
    contextBackfillFailed += filled.failedFiles;
    stats.symbolContextBackfill = {
      symbols: filled.symbols,
      embeddingTexts: filled.embeddingTexts,
      failedFiles: contextBackfillFailed,
    };
    log.info("symbol context filled in for a graph written before it was stored", {
      projectId,
      ...stats.symbolContextBackfill,
    });
  }

  // Step 8 — finalise CodeGraph counts.
  const totalSymbols = await prisma.codeSymbol.count({ where: { codeGraphId: graph.id } });
  const totalEdges = await prisma.codeEdge.count({ where: { codeGraphId: graph.id } });
  // #715 — one `module` symbol per file, the same index `loadExistingFiles` reads.
  const totalFiles = await prisma.codeSymbol.count({
    where: { codeGraphId: graph.id, kind: "module" },
  });
  stats.graphFiles = totalFiles;
  stats.graphSymbols = totalSymbols;
  stats.graphEdges = totalEdges;
  const langGrouping = await prisma.codeSymbol.groupBy({
    by: ["language"],
    where: { codeGraphId: graph.id },
    _count: { _all: true },
  });
  const langStatsRecord: Record<string, number> = {};
  for (const row of langGrouping) {
    langStatsRecord[row.language] = row._count._all;
  }
  // #1071 — what is left of Go binding, and for how many more ingests it may
  // be, was decided by `persistParsed` before it wrote a row
  // ({@link GO_BINDING_RESUME_GRACE}).
  const goResumesLeft = goBindingEnd.resumesLeft;
  if (goBindingEnd.abandonedNow.length > 0) {
    log.warn(
      "Go call binding abandoned: these files were still open after every ingest the floor needs and three more; their remaining calls are undecided by type (the name-based answer, never an older type binding) until the file, or any Go file, changes",
      {
        projectId,
        count: goBindingEnd.abandonedNow.length,
        files: goBindingEnd.abandonedNow.slice(0, NAMED_FILES_CAP),
      },
    );
  }
  if (stats.goBinding) stats.goBinding.abandonedFiles = goBindingAbandoned.size;
  const finalise = prisma.codeGraph.update({
    where: { id: graph.id },
    data: {
      symbolCount: totalSymbols,
      edgeCount: totalEdges,
      languageStats: JSON.stringify(langStatsRecord),
      lastIndexedAt: new Date(),
      lineageFingerprint: recordedFingerprint,
      // #1071 — the version says every stored row has the current shape,
      // EXCEPT the files listed beside it: those an upgrade could not reach,
      // each with the hash of the content that failed. The upgrade is then not
      // repeated for the rest of the tree, and a listed file is retried only
      // when its content changes.
      //
      // It is NOT stamped while calls are left that were never resolved by
      // type: the graph then carries the record of what is left instead, and
      // the version follows on the ingest that finishes it — or that gives
      // the remainder up ({@link GO_BINDING_RESUME_GRACE}). Calls waiting to
      // be re-bound after a change (`again`) do not hold it back: their rows
      // have the current shape and an answer.
      ...(goBindingLeft.size === 0 ? { extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION } : {}),
      // #1072 — every symbol row now has its context columns: this run wrote
      // them (a full ingest, or a new graph), filled them in, or found them
      // current. Not recorded while a file of the graph could not be read.
      ...(contextBackfillFailed === 0 ? { symbolContextVersion: SYMBOL_CONTEXT_VERSION } : {}),
      // This write also ends the run: `inFlight` goes.
      goBindingIncomplete: writeGoBindingIncomplete({
        files: goBindingLeft,
        again: goBindingAgainLeft,
        inFlight: false,
        resumesLeft: goResumesLeft,
        abandoned: goBindingAbandoned,
      }),
      extractorUpgradeFailed:
        upgradeFailures.size > 0 ? JSON.stringify(Object.fromEntries(upgradeFailures)) : null,
      // #758 — the commit label moves only when the graph is complete.
      ...(commitSha ? { commitSha } : {}),
    },
  });
  if (commitSha && repoConnectionId) {
    // #758 — the connector's `lastCommitSha` (the commit the connections page
    // says the graph reflects) is written here and nowhere else in an ingest,
    // in the same transaction as the graph's label, so the two cannot drift.
    await prisma.$transaction([
      finalise,
      prisma.repoConnection.updateMany({
        where: { id: repoConnectionId },
        data: { lastCommitSha: commitSha },
      }),
    ]);
  } else {
    await finalise;
  }

  // Step 9 — Epic #780 / Issue #797. Symbols (and their index-time text) are
  // durable now; hand the embedding off to a background job. Fire-and-forget:
  // it must never fail or delay the ingest that produced them.
  if (options.embedSymbols) {
    enqueueSymbolEmbeddings(projectId);
  }

  stats.durationMs = Date.now() - start;
  reportIngest(projectId, stats);
  return stats;
}

/** Record a file the parser gave up on, by name while the list has room. */
function noteUnparseable(stats: IngestStats, relPath: string): void {
  stats.filesUnparseableCount += 1;
  if (stats.filesUnparseable.length < NAMED_FILES_CAP) stats.filesUnparseable.push(relPath);
}

/**
 * Record a file an extractor upgrade could not reach: by name while the list
 * has room, and with the hash of the content that failed (null: unreadable) so
 * the graph remembers it.
 */
function noteUpgradeFailed(
  stats: IngestStats,
  failures: Map<string, string | null>,
  relPath: string,
  contentHash: string | null,
): void {
  if (failures.has(relPath)) return;
  failures.set(relPath, contentHash);
  stats.filesUpgradeFailedCount += 1;
  if (stats.filesUpgradeFailed.length < NAMED_FILES_CAP) stats.filesUpgradeFailed.push(relPath);
}

/** `CodeGraph.extractorUpgradeFailed` as a map; anything unreadable is "nothing remembered". */
export function parseUpgradeFailures(
  stored: string | null | undefined,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!stored) return out;
  try {
    // Anything that is not a path → hash object yields no entry the walk knows
    // (or throws, for `null`): either way nothing is remembered.
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    for (const [file, hash] of Object.entries(parsed)) {
      out.set(file, typeof hash === "string" ? hash : null);
    }
  } catch {
    // A corrupt value costs one retry of the files it named, nothing else.
  }
  return out;
}

/**
 * #1071 — say in the log what a slow or partial ingest did: which files could
 * not be parsed or upgraded (by name), and what re-binding Go cost. Silent for
 * a run with none of these.
 */
function reportIngest(projectId: string, stats: IngestStats): void {
  if (stats.filesUnparseableCount > 0) {
    log.warn("Code graph ingest could not parse some files; their rows are missing or stale", {
      projectId,
      count: stats.filesUnparseableCount,
      files: stats.filesUnparseable,
    });
  }
  if (stats.filesUpgradeFailedCount > 0) {
    log.warn(
      "Code graph extractor upgrade incomplete: these files keep rows an older extractor wrote until their content changes",
      {
        projectId,
        count: stats.filesUpgradeFailedCount,
        files: stats.filesUpgradeFailed,
        filesUpgraded: stats.filesUpgraded,
      },
    );
  } else if (stats.filesUpgraded > 0) {
    log.info("Code graph upgraded in place to the current extractor version", {
      projectId,
      filesUpgraded: stats.filesUpgraded,
      extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION,
    });
  }
  if (stats.goBinding) {
    const { errors, overBudget, skipped } = stats.goBinding;
    const incomplete = errors + overBudget + skipped > 0;
    log[incomplete ? "warn" : "info"](
      incomplete
        ? "Go calls bound by type; some were left undecided by type (errors: resolution threw, overBudget: a step budget ran out, skipped: the time ceiling or the heap watchdog was reached, see `stopReason` — recorded on the graph as `incomplete` and resumed by the next ingest)"
        : "Go calls bound by type",
      {
        projectId,
        ...stats.goBinding,
        filesRebound: stats.filesRebound,
      },
    );
  }
}

/**
 * Async generator that yields absolute paths for every file under `rootDir`
 * that survives the ignore rules. Directories are filtered before recursion
 * so `node_modules` etc. never get walked into. `onIgnoredFile` is told each
 * FILE the rules hide inside a directory that is walked.
 */
async function* walkTree(
  rootDir: string,
  rules: ReturnType<typeof compileMetisignore>,
  onIgnoredFile: (relPath: string) => void = () => {},
  current: string = rootDir,
): AsyncGenerator<string> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(current, entry.name);
    const rel = path.relative(rootDir, abs).split(path.sep).join("/");
    if (isIgnored(rules, rel, entry.isDirectory())) {
      // An ignored directory is another package's; an ignored FILE sits in a
      // directory the walk does read, and is reported.
      if (entry.isFile()) onIgnoredFile(rel);
      continue;
    }
    if (entry.isDirectory()) {
      yield* walkTree(rootDir, rules, onIgnoredFile, abs);
    } else if (entry.isFile()) {
      yield abs;
    }
  }
}

async function upsertCodeGraph(
  prisma: PrismaClient,
  projectId: string,
  repoConnectionId: string | undefined,
): Promise<{
  id: string;
  lineageFingerprint: string | null;
  extractorVersion: number | null;
  extractorUpgradeFailed: string | null;
  goBindingIncomplete: string | null;
  symbolContextVersion: number | null;
}> {
  // #758 — the commit label is written by Step 8, not here: a run that fails
  // part-way must not relabel a graph it never finished rebuilding.
  const existing = await prisma.codeGraph.findFirst({
    where: { projectId, repoConnectionId: repoConnectionId ?? null },
  });
  if (existing) return existing;
  return prisma.codeGraph.create({
    data: {
      projectId,
      repoConnectionId: repoConnectionId ?? null,
    },
    select: {
      id: true,
      lineageFingerprint: true,
      extractorVersion: true,
      extractorUpgradeFailed: true,
      goBindingIncomplete: true,
      symbolContextVersion: true,
    },
  });
}

/** #1071 — a `go.mod`'s directory and `module` path; null when it cannot be read or names none. */
async function readGoModule(rootDir: string, filePath: string): Promise<GoModule | null> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(GO_MOD_READ_LIMIT);
      const { bytesRead } = await handle.read(buf, 0, GO_MOD_READ_LIMIT, 0);
      const modulePath = parseGoModulePath(buf.toString("utf8", 0, bytesRead));
      if (!modulePath) return null;
      const dir = path.relative(rootDir, path.dirname(filePath)).split(path.sep).join("/");
      return { dir, path: modulePath };
    } finally {
      await handle.close();
    }
  } catch {
    // Unreadable go.mod — imports then resolve by directory suffix.
    return null;
  }
}

async function loadExistingFiles(
  prisma: PrismaClient,
  codeGraphId: string,
): Promise<Map<string, { contentHash: string; language: string }>> {
  // Module symbols carry the file-level hash in `contentHash` (parsers
  // populate it from the full source). Use them as the file-hash index.
  const rows = await prisma.codeSymbol.findMany({
    where: { codeGraphId, kind: "module" },
    select: { filePath: true, contentHash: true, language: true },
  });
  const out = new Map<string, { contentHash: string; language: string }>();
  for (const r of rows) out.set(r.filePath, { contentHash: r.contentHash, language: r.language });
  return out;
}

/**
 * #313 — what an incremental ingest knows about the rest of the tree. A full
 * ingest passes an empty `unchangedFiles`.
 */
interface IngestTreeState {
  rootDir: string;
  /** Files skipped because their hash is unchanged, with their persisted language. */
  unchangedFiles: ReadonlyMap<string, { language: string; contentHash: string }>;
  /** Every file the graph held before this run. */
  previousPaths: ReadonlySet<string>;
  /** Files the graph holds that the walk no longer finds. */
  deletedPaths: string[];
  /** #1071 — the tree's `go.mod` files. */
  goModules: readonly GoModule[];
  /** #1071 — Go files of the tree this run did not read: unparseable, unreadable, or hidden by the ignore rules. */
  unparsedGoPaths: readonly string[];
  /** #1071 — languages whose unchanged files an older extractor wrote ({@link extractorUpgradeLanguages}). */
  upgradeLanguages: ReadonlySet<string>;
  /** #1071 — unchanged files an earlier upgrade failed on whose content has changed since: tried again. */
  upgradeRetryPaths: ReadonlySet<string>;
  /** #1071 — files this run leaves un-upgraded, with the hash of the content that failed. */
  upgradeFailures: Map<string, string | null>;
  /** #1071 — the next value of `CodeGraph.extractorUpgradedAt`: later than every one before it. */
  nextUpgradeMark: () => Date;
  /** #1071 — the ceiling on time spent resolving Go calls by type ({@link GO_BINDING_MAX_MS}). */
  goBindingMaxMs: number;
  /** #1071 — calls resolved whatever the ceiling says ({@link GO_BINDING_MIN_CALLS}). */
  goBindingMinCalls: number;
  /** #1071 — the clock the ceiling is measured with. */
  goBindingNow: () => number;
  /** #1071 — heap growth, in bytes, at which the step stops ({@link GO_BINDING_MAX_HEAP_GROWTH}). */
  goBindingMaxHeapGrowth: number;
  /** #1071 — what the heap watchdog reads, in bytes. */
  goBindingHeapUsed: () => number;
  /** #1071 — the allowance the graph's record holds ({@link GoBindingIncomplete.resumesLeft}); null when none. */
  goBindingResumesLeft: number | null;
  /** #1071 — what this run decided about the allowance: filled by `persistParsed`. */
  goBindingEnd: GoBindingEnd;
  /** #1071 — files an earlier run's ceiling left open, and the call index each resumes at ({@link GoBindingIncomplete.files}). */
  goBindingPending: ReadonlyMap<string, number>;
  /** #1071 — files waiting to be re-bound after a Go change, and where each resumes ({@link GoBindingIncomplete.again}). */
  goBindingAgain: ReadonlyMap<string, number>;
  /** #1071 — the last ingest that bound Go calls did not reach its end ({@link GoBindingIncomplete.inFlight}). */
  goBindingInterrupted: boolean;
  /** #1071 — the files THIS run leaves open in turn: filled by `persistParsed`. */
  goBindingLeft: Map<string, number>;
  /** #1071 — the files THIS run leaves to be re-bound: filled by `persistParsed`. */
  goBindingAgainLeft: Map<string, number>;
  /** #1071 — files given up on; `persistParsed` removes those this run re-bound, rewrote or found deleted. */
  goBindingAbandoned: Map<string, number>;
  /** #1071 — record on the graph that this run re-binds Go calls after a change; called before its first row. */
  markGoBindingInFlight: () => Promise<void>;
  /** #1071 — the pending work is the rest of an extractor upgrade (the version is not stamped yet). */
  goBindingResumesUpgrade: boolean;
}

/** #1071 — how a run's Go binding ends, as far as the next ingest is concerned. */
interface GoBindingEnd {
  /** {@link GoBindingIncomplete.resumesLeft} as this run leaves it; null when nothing is open. */
  resumesLeft: number | null;
  /** The files this run gave up on ({@link GO_BINDING_RESUME_GRACE}). */
  abandonedNow: string[];
}

/** #1071 — what the binding step decided for one Go call, before any row is written. */
interface PlannedGoCall {
  verdict: GoCallVerdict;
  /**
   * The call was NOT resolved by type in this run — the ceiling, a step
   * budget, a throw, or (resuming) it was resolved by an earlier run and not
   * looked at again. Its stored row, if it has one, is the better answer.
   */
  unresolved: boolean;
  /**
   * The call is what an interrupted extractor upgrade left: never resolved by
   * type, in a file the upgrade rewrote, on a graph whose version is not
   * stamped yet. Writing its answer is one more write of that upgrade.
   */
  upgrade?: true;
}

const GO_CALL_NOT_RESOLVED: PlannedGoCall = { verdict: { kind: "unknown" }, unresolved: true };

/**
 * Undecided by type, and WRITTEN: the name-evidence answer replaces what the
 * row holds. For a call given up on whose stored answer predates the last
 * change to a Go file ({@link GO_BINDING_RESUME_GRACE}).
 */
const GO_CALL_GIVEN_UP: PlannedGoCall = { verdict: { kind: "unknown" }, unresolved: false };

/** `metadata` of every verdict the TYPE resolver writes — all but `name`. */
const GO_TYPE_METADATA: readonly string[] = (
  [
    "package",
    "same-package",
    "receiver-type",
    "external",
    "external-assumed",
    "interface",
    "func-value",
    "conversion",
    "ambiguous",
  ] as const satisfies readonly GoResolution[]
).map(goResolutionMetadata);

/** `metadata` of a Go call edge that says it IS bound: with no target left, there is no answer to keep. */
const GO_BOUND_METADATA: ReadonlySet<string> = new Set(
  (["package", "same-package", "receiver-type", GO_RESOLUTION_NAME] as const).map(
    goResolutionMetadata,
  ),
);

async function persistParsed(
  prisma: PrismaClient,
  codeGraphId: string,
  projectId: string,
  parsedFiles: ParsedFile[],
  stats: IngestStats,
  sourceByRelPath: Map<string, string>,
  maybeYield: MaybeYield,
  tree: IngestTreeState,
): Promise<void> {
  // ── Pass 0 (#313): capture what the changed files used to define, then prune
  // deleted files. Must run before pass 1: re-creating a changed file's symbols
  // nulls every edge into them (`onDelete: SetNull`), erasing which unchanged
  // files pointed there.
  const changedPaths = [...parsedFiles.map((f) => f.filePath), ...tree.deletedPaths];
  // #1071 — a changed or deleted Go file re-binds Go calls, and its new content
  // hash is among the first rows written below. Say so on the graph first.
  if (
    parsedFiles.some((f) => f.language === "go") ||
    tree.deletedPaths.some((p) => detectLanguage(p) === "go")
  ) {
    await tree.markGoBindingInFlight();
  }
  const previousTargets =
    tree.unchangedFiles.size > 0
      ? await loadPreviousTargets(prisma, codeGraphId, changedPaths, tree.unchangedFiles)
      : { names: new Set<string>(), affected: new Set<string>() };
  for (let k = 0; k < tree.deletedPaths.length; k += IN_LIST_CHUNK) {
    const chunk = tree.deletedPaths.slice(k, k + IN_LIST_CHUNK);
    await prisma.$transaction([
      prisma.codeEdge.deleteMany({ where: { codeGraphId, filePath: { in: chunk } } }),
      prisma.codeSymbol.deleteMany({ where: { codeGraphId, filePath: { in: chunk } } }),
    ]);
  }

  // ── Pass 1: persist symbols and build resolution indices. ───────────────
  // The legacy single-pass loop only resolved edges via exact `qualifiedName`
  // match, which never works for bare-identifier callees like `foo()` —
  // those carry the textual name (e.g. `"foo"`) as toQualifiedName, not the
  // fully-qualified `path::Class::foo`. Result: ~100% of `calls`/`references`
  // edges had a null `toSymbolId` and the in-degree ranking on the project
  // overview rendered empty (issue #383 AC #6).
  //
  // This two-pass design resolves edges by walking up a hierarchy of indices:
  //   1. exact qualifiedName (intra-project)
  //   2. same-file `name` lookup (e.g. local helper invocations)
  //   3. import-targeted `name` lookup (cross-file via `imports` edges)
  //   4. unique project-wide `name` (last resort, only if exactly one match)
  //   5. unresolved → toSymbolId stays null, toQualifiedName preserved.
  //
  // Issue #17 — steps 2-4 apply to BARE calls only. A member call (`x.join()`)
  // is resolved with the receiver as evidence and never by project-wide name
  // uniqueness; built-in and test-framework names are never bound by name
  // alone. The rules live in `call-resolution.ts`.
  //
  // All lookups are in-memory after pass 1; no per-edge DB round-trips.
  const qnameToId = new Map<string, string>();
  const index = createResolutionIndex();

  for (const file of parsedFiles) {
    await maybeYield();
    // Wipe previous symbols+edges for this file so we don't accumulate stale rows,
    // and insert its symbols — one batch transaction per FILE (#16). On SQLite a
    // statement outside a transaction is its own commit, and each commit is a
    // synchronous journal write + fsync on the event-loop thread; per-row commits
    // made the persist phase ~420k of them for this repository.
    // #1072 — what the file says about each symbol (declaration, doc comment,
    // receiver, package), read while the source is in memory and stored on the row.
    const sourceLines = (sourceByRelPath.get(file.filePath) ?? "").split("\n");
    const contexts = ownContextsOf(file.filePath, file.language, sourceLines, file.symbols);
    const results = await prisma.$transaction([
      prisma.codeEdge.deleteMany({ where: { codeGraphId, filePath: file.filePath } }),
      prisma.codeSymbol.deleteMany({ where: { codeGraphId, filePath: file.filePath } }),
      ...file.symbols.map((sym, i) =>
        prisma.codeSymbol.create({
          data: {
            codeGraphId,
            projectId,
            kind: sym.kind,
            name: sym.name,
            qualifiedName: sym.qualifiedName,
            filePath: file.filePath,
            startLine: sym.startLine,
            endLine: sym.endLine,
            language: file.language,
            contentHash: sym.contentHash,
            ...contexts[i],
          },
          select: { id: true },
        }),
      ),
    ]);
    const createdIds = (results.slice(2) as Array<{ id: string }>).map((r) => r.id);

    // Issue #797 — the index-time embedding TEXT is formatted HERE, while the
    // source file is still in memory. It cannot be rebuilt later: `CodeSymbol`
    // persists no body, so a background embed job or an #787 model-flip reindex
    // has nothing to format from. Hence `CodeSymbolEmbedding.text`.
    const embeddingRows: Array<{
      codeGraphId: string;
      projectId: string;
      symbolId: string;
      text: string;
      contentHash: string;
    }> = [];

    for (const [i, sym] of file.symbols.entries()) {
      const id = createdIds[i];
      const idx: ResolvableSymbol = {
        id,
        name: sym.name,
        qualifiedName: sym.qualifiedName,
        filePath: file.filePath,
        kind: sym.kind,
        language: file.language,
      };
      // First definition of a name within a file wins (deterministic).
      indexSymbol(index, idx);
      qnameToId.set(sym.qualifiedName, id);
      stats.symbolsUpserted += 1;

      const text = embeddingTextOf({ ...sym, id }, file.filePath, contexts[i], sourceLines);
      embeddingRows.push({
        codeGraphId,
        projectId,
        symbolId: id,
        text,
        contentHash: computeSymbolHash(text),
        // `embeddingModel` defaults to "" = PENDING. The background job embeds it.
      });
    }

    // The old rows for this file's symbols were cascade-deleted with the symbols
    // above, so these are always fresh inserts.
    if (embeddingRows.length > 0) {
      await prisma.codeSymbolEmbedding.createMany({ data: embeddingRows });
    }
  }

  // ── Pass 1a (#1071): unchanged files an older extractor wrote. Re-parse them
  // and rewrite, on the EXISTING rows, the qualified names the current parser
  // gives their symbols — before pass 1b reads those rows into the indices.
  const upgradedFiles: ParsedFile[] = [];
  // What re-parsing unchanged Go files costs is reported (`stats.goBinding`).
  let goParseMs = 0;
  // A file that failed once is not read again by a later pass of this run.
  const notReparsed = new Set<string>();
  const notReparsedWhy = new Map<string, "unreadable" | "unparseable">();
  const reparse = async (relPath: string): Promise<ParsedFile | null> => {
    if (notReparsed.has(relPath)) return null;
    const isGo = tree.unchangedFiles.get(relPath)?.language === "go";
    const t0 = isGo ? performance.now() : 0;
    const out = await reparseUnchanged(tree, relPath);
    if (isGo) goParseMs += performance.now() - t0;
    if (typeof out !== "string") return out;
    notReparsed.add(relPath);
    notReparsedWhy.set(relPath, out);
    if (out === "unparseable") noteUnparseable(stats, relPath);
    return null;
  };
  if (tree.upgradeLanguages.size > 0 || tree.upgradeRetryPaths.size > 0) {
    // The one table that names a symbol by text and has no index to find it
    // by: read once for the whole upgrade, not once per renamed symbol.
    let proposals: ColumnProposalWriters | null = null;
    for (const [relPath, file] of tree.unchangedFiles) {
      if (!tree.upgradeLanguages.has(file.language) && !tree.upgradeRetryPaths.has(relPath)) {
        continue;
      }
      await maybeYield();
      const reparsed = await reparse(relPath);
      if (!reparsed) {
        // Its rows keep the old shape: named, and remembered with this content's hash.
        const unreadable = notReparsedWhy.get(relPath) === "unreadable";
        noteUpgradeFailed(
          stats,
          tree.upgradeFailures,
          relPath,
          unreadable ? null : file.contentHash,
        );
        continue;
      }
      proposals ??= await loadColumnProposalWriters(prisma, projectId);
      await renameSymbolsInPlace(prisma, codeGraphId, reparsed, proposals, tree.nextUpgradeMark);
      upgradedFiles.push(reparsed);
    }
    stats.filesUpgraded += upgradedFiles.length;
  }
  const upgradedPaths = new Set(upgradedFiles.map((f) => f.filePath));

  // ── Pass 1b (#313): the unchanged files join the indices, so an edge resolves
  // against the whole tree exactly as a full ingest would. Only parser-written
  // symbols are loaded — a full ingest's pass 2 runs before the schema passes
  // add theirs (`source` set, or the `sql` origin symbols of a mapper file).
  // Ordered by id, i.e. creation order, so first-definition-wins matches the
  // parse order a full ingest indexes in.
  if (tree.unchangedFiles.size > 0) {
    const rows = await prisma.codeSymbol.findMany({
      where: { codeGraphId, source: null },
      select: {
        id: true,
        name: true,
        qualifiedName: true,
        filePath: true,
        kind: true,
        language: true,
      },
      orderBy: { id: "asc" },
    });
    for (const row of rows) {
      if (tree.unchangedFiles.get(row.filePath)?.language !== row.language) continue;
      indexSymbol(index, row);
      qnameToId.set(row.qualifiedName, row.id);
    }
  }

  // ── Pass 1c (#313): unchanged files whose edges may now bind differently.
  // An edge resolves by its target NAME (every index is keyed by it) and by the
  // files its file imports, so an unchanged file is affected only when it
  //   - pointed at a symbol of a changed or deleted file (captured in pass 0),
  //   - references a name a changed or deleted file defines or defined, or
  //   - imports a path that resolves differently now that files were added or
  //     removed.
  // Everything else would resolve exactly as it did, so it is left alone.
  const allPaths = [...parsedFiles.map((f) => f.filePath), ...tree.unchangedFiles.keys()];
  const importCtx = buildImportResolutionContext(allPaths);
  const affectedFiles: ParsedFile[] = [];
  // #1071 — set when a Go file moved (or the last run that bound Go calls
  // never reached its end): every unchanged Go file is re-bound from its
  // first call. Otherwise a run only FINISHES what an earlier one left open,
  // and the calls resolved then still stand.
  let goRebindAll = false;
  let goResumeOnly = false;
  // Unchanged Go files read for their declarations alone (their edges stand).
  const goDeclarationFiles: ParsedFile[] = [];
  if (tree.unchangedFiles.size > 0) {
    const names = previousTargets.names;
    for (const file of parsedFiles) {
      for (const sym of file.symbols) {
        names.add(sym.name);
        names.add(sym.qualifiedName);
      }
    }
    const affected = previousTargets.affected;
    for (const fp of await filesReferencing(prisma, codeGraphId, names)) {
      if (tree.unchangedFiles.has(fp)) affected.add(fp);
    }
    const added = parsedFiles.some((f) => !tree.previousPaths.has(f.filePath));
    if (added || tree.deletedPaths.length > 0) {
      const before = buildImportResolutionContext(tree.previousPaths);
      const imports = await prisma.codeEdge.findMany({
        where: { codeGraphId, kind: "imports", source: null },
        select: { filePath: true, toQualifiedName: true },
      });
      for (const imp of imports) {
        const file = tree.unchangedFiles.get(imp.filePath);
        if (!file || affected.has(imp.filePath) || imp.toQualifiedName === null) continue;
        const was = resolveImportTarget(imp.filePath, file.language, imp.toQualifiedName, before);
        const now = resolveImportTarget(
          imp.filePath,
          file.language,
          imp.toQualifiedName,
          importCtx,
        );
        if (was !== now) affected.add(imp.filePath);
      }
    }
    // #1071 — a Go call binds through declarations anywhere in the tree (the
    // field `store` in one file, the methods of its type in another package),
    // none of which is persisted. So when any Go file is parsed, deleted or
    // re-bound, every unchanged Go file is re-parsed for its declarations and
    // has its edges re-bound — which changes nothing where nothing moved.
    goRebindAll =
      tree.goBindingInterrupted ||
      parsedFiles.some((f) => f.language === "go") ||
      upgradedFiles.some((f) => f.language === "go") ||
      tree.deletedPaths.some((p) => detectLanguage(p) === "go") ||
      [...affected].some((p) => tree.unchangedFiles.get(p)?.language === "go");
    if (goRebindAll) {
      for (const [relPath, file] of tree.unchangedFiles) {
        if (file.language === "go") affected.add(relPath);
      }
    } else if (tree.goBindingPending.size > 0 || tree.goBindingAgain.size > 0) {
      // Nothing in Go moved, but an earlier run's ceiling left calls open:
      // those files are re-bound from where they stopped, and nothing else is.
      goResumeOnly = true;
      // (A listed file that is not unchanged would have been a changed or a
      // deleted Go file, and this branch not taken; one the walk could not
      // read fails its re-parse below and stays on the record.)
      for (const relPath of tree.goBindingPending.keys()) affected.add(relPath);
      for (const relPath of tree.goBindingAgain.keys()) affected.add(relPath);
    }
    for (const relPath of affected) {
      // An upgraded file is already re-parsed, and its edges are rewritten below.
      if (upgradedPaths.has(relPath)) continue;
      await maybeYield();
      const reparsed = await reparse(relPath);
      if (reparsed) affectedFiles.push(reparsed);
    }
    stats.filesRebound += affectedFiles.length;
    if (goResumeOnly) {
      // The resolver needs every Go file's declarations, whoever's calls it decides.
      for (const [relPath, file] of tree.unchangedFiles) {
        if (file.language !== "go" || affected.has(relPath)) continue;
        await maybeYield();
        const reparsed = await reparse(relPath);
        if (reparsed) goDeclarationFiles.push(reparsed);
      }
    }
  }

  // ── Pass 2: build import-target index and persist edges. ────────────────
  const { importTargets, runtimeImports } = buildFileImportIndex(
    [...parsedFiles, ...affectedFiles, ...upgradedFiles],
    importCtx,
  );
  const now = tree.goBindingNow;
  const goT0 = now();
  // The heap watchdog's baseline: everything the step holds from here on —
  // the resolver, its caches, the plan — is growth ({@link GO_BINDING_MAX_HEAP_GROWTH}).
  const goHeap0 = tree.goBindingHeapUsed();
  const goBuilt = buildGoResolver(
    [...parsedFiles, ...affectedFiles, ...upgradedFiles, ...goDeclarationFiles],
    tree.goModules,
    [
      ...tree.unparsedGoPaths,
      ...[...tree.unchangedFiles].filter(([, f]) => f.language === "go").map(([p]) => p),
    ],
  );
  // Held in ONE place, so that releasing it frees its caches.
  let goResolver = goBuilt.resolver;
  goBuilt.resolver = null;
  /** A resolver was built: Go calls go through the plan, also once it is released. */
  const goTyped = goResolver !== null;
  /** Why the step stopped early, if it did, and — for the heap watchdog — the growth it read. */
  const goStop = {
    reason: null as "time" | "memory" | null,
    heapGrowth: null as number | null,
  };
  const goBinding = {
    files: goBuilt.files,
    calls: 0,
    errors: goBuilt.failed ? 1 : 0,
    failures: goBuilt.failed ? ["(the resolver could not be built)"] : ([] as string[]),
    overBudget: 0,
    skipped: 0,
    resumedFiles: 0,
  };
  let goResolveMs = now() - goT0;
  /** Calls handed to the resolver so far: the first `goBindingMinCalls` go whatever the clock says. */
  let goAttempted = 0;
  /** What the resolver counted as kept when the heap was last read ({@link GO_BINDING_HEAP_SAMPLE_ENTRIES}). */
  let goSampledAt = 0;
  /**
   * One Go call's verdict. Resolution is the only step between a resolver bug
   * and a failed ingest, so a throw is counted, NAMED, and the call is left
   * UNDECIDED (`unknown`) — never a decided verdict, which later readers would
   * trust. The same holds for a call the resolver gave up on (its step budget)
   * and for every call that comes up after the step's time ceiling: undecided
   * by type, counted, and marked `unresolved` — so that the answer an earlier,
   * complete run stored for it is kept rather than replaced by a guess.
   * `null` is the ceiling: the call was not looked at.
   */
  const goVerdict = (filePath: string, edge: ParsedEdge, callee: GoExpr): PlannedGoCall | null => {
    goBinding.calls += 1;
    if (goStop.reason === null) {
      if (goAttempted >= tree.goBindingMinCalls && goResolveMs > tree.goBindingMaxMs) {
        goStop.reason = "time";
      } else if (
        goAttempted % GO_BINDING_HEAP_SAMPLE_CALLS === 0 ||
        (goResolver !== null &&
          goResolver.retainedTotal() - goSampledAt >= GO_BINDING_HEAP_SAMPLE_ENTRIES)
      ) {
        // The last resort, independent of the resolver's own accounting: no
        // floor, since the alternative is an abort nothing can catch. (The
        // resolver's count only says WHEN to look sooner than the call count
        // would; what is compared with the limit is the heap.)
        goSampledAt = goResolver?.retainedTotal() ?? 0;
        const growth = tree.goBindingHeapUsed() - goHeap0;
        if (growth > tree.goBindingMaxHeapGrowth) {
          goStop.reason = "memory";
          goStop.heapGrowth = growth;
          // Released: its caches are what grew.
          goResolver = null;
        }
      }
    }
    const resolver = goResolver;
    if (goStop.reason !== null || resolver === null) {
      goBinding.skipped += 1;
      return null;
    }
    goAttempted += 1;
    const t0 = now();
    try {
      const verdict = resolver.resolveCall(filePath, callee);
      const overBudget = verdict.kind === "unknown" && verdict.why === "budget";
      if (overBudget) goBinding.overBudget += 1;
      return { verdict, unresolved: overBudget };
    } catch {
      goBinding.errors += 1;
      if (goBinding.failures.length < NAMED_FILES_CAP) {
        goBinding.failures.push(`${filePath}:${edge.line} ${edge.toQualifiedName}`);
      }
      return GO_CALL_NOT_RESOLVED;
    } finally {
      goResolveMs += now() - t0;
    }
  };

  // ── The Go binding plan (#1071): every Go call's verdict, worked out BEFORE
  // any edge is written, in the order that finishes old work first.
  //
  //   1. What was NEVER resolved by type: the files an earlier run's ceiling
  //      left open, each from the call it stopped at — also when another Go
  //      file changed since, so each ingest gets further on them whatever the
  //      repository is doing (taking them up from their first call again made
  //      an active repository with one slow file never finish — PR #1104
  //      review cycle 4) — then the files this run parsed or upgraded, whole.
  //   2. What is to be resolved AGAIN: when a Go file moved, every unchanged
  //      Go file from its first call (up to where step 1 took over); otherwise
  //      what an earlier run left of such a pass.
  //
  // Once the ceiling is reached every later call is skipped, so step 2 starts
  // only when step 1 is complete.
  const goPlan = new Map<ParsedEdge, PlannedGoCall>();
  let goIncompleteCalls = 0;
  const goPlanned = new Set<string>();
  const goPlannedAgain = new Set<string>();
  const goResumed = new Set<string>();
  const goRewritten = new Set<string>();
  for (const f of parsedFiles) if (f.language === "go") goRewritten.add(f.filePath);
  for (const f of upgradedFiles) if (f.language === "go") goRewritten.add(f.filePath);
  if (goTyped) {
    /**
     * Plan the Go calls of `file` with index in [from, to). Returns the index
     * of the first one the ceiling skipped (-1: none) and how many it skipped.
     */
    const planCalls = async (
      file: ParsedFile,
      from: number,
      to: number,
      upgrade: boolean,
    ): Promise<{ firstSkipped: number; skipped: number }> => {
      let index = -1;
      let firstSkipped = -1;
      let skipped = 0;
      for (const edge of file.edges) {
        if (edge.kind !== "calls" || !edge.goCallee) continue;
        index += 1;
        // No plan for it: its stored row stands (`resolveEdge`).
        if (index < from) continue;
        if (index >= to) break;
        await maybeYield();
        const planned = goVerdict(file.filePath, edge, edge.goCallee);
        if (planned === null) {
          goPlan.set(edge, GO_CALL_NOT_RESOLVED);
          if (firstSkipped === -1) firstSkipped = index;
          skipped += 1;
        } else goPlan.set(edge, upgrade ? { ...planned, upgrade: true } : planned);
      }
      return { firstSkipped, skipped };
    };
    const candidates = [...parsedFiles, ...upgradedFiles, ...affectedFiles].filter(
      (f) => f.language === "go",
    );
    const pendingFirst = [
      ...candidates.filter((f) => tree.goBindingPending.has(f.filePath)),
      ...candidates.filter((f) => !tree.goBindingPending.has(f.filePath)),
    ];
    for (const file of pendingFirst) {
      const pendingAt = tree.goBindingPending.get(file.filePath);
      const rewritten = goRewritten.has(file.filePath);
      if (!rewritten && pendingAt === undefined) continue;
      if (pendingAt !== undefined) goResumed.add(file.filePath);
      goPlanned.add(file.filePath);
      // A file this run rewrote has no call resolved yet; an unchanged one is
      // taken up at its recorded call, and what it writes there is — on a
      // graph not stamped yet — the rest of the upgrade.
      const left = await planCalls(
        file,
        rewritten ? 0 : (pendingAt ?? 0),
        Number.POSITIVE_INFINITY,
        !rewritten && tree.goBindingResumesUpgrade,
      );
      if (left.firstSkipped !== -1) {
        tree.goBindingLeft.set(file.filePath, left.firstSkipped);
        goIncompleteCalls += left.skipped;
      }
    }
    for (const file of affectedFiles) {
      if (file.language !== "go" || goRewritten.has(file.filePath)) continue;
      const from = goRebindAll ? 0 : tree.goBindingAgain.get(file.filePath);
      if (from === undefined) continue;
      if (tree.goBindingAgain.has(file.filePath)) goResumed.add(file.filePath);
      goPlannedAgain.add(file.filePath);
      // Its calls from the recorded index on were never resolved: step 1 had them.
      const to = tree.goBindingPending.get(file.filePath) ?? Number.POSITIVE_INFINITY;
      const left = await planCalls(file, from, to, false);
      if (left.firstSkipped !== -1) {
        tree.goBindingAgainLeft.set(file.filePath, left.firstSkipped);
        goIncompleteCalls += left.skipped;
      } else {
        // Bound again from its first call: whatever was given up on is not any more.
        if (from === 0 && to === Number.POSITIVE_INFINITY) {
          tree.goBindingAbandoned.delete(file.filePath);
        }
      }
    }
  }
  goBinding.resumedFiles = goResumed.size;
  // A file still open that this run did not get to look at (it could not be
  // re-read, or no resolver could be built) stays open where it was — from its
  // first call when this run rewrote its rows.
  const deletedNow = new Set(tree.deletedPaths);
  for (const [relPath, at] of tree.goBindingPending) {
    if (goPlanned.has(relPath) || deletedNow.has(relPath)) continue;
    tree.goBindingLeft.set(relPath, goRewritten.has(relPath) ? 0 : at);
  }
  for (const [relPath, at] of tree.goBindingAgain) {
    if (goPlannedAgain.has(relPath) || deletedNow.has(relPath) || goRewritten.has(relPath)) {
      continue;
    }
    tree.goBindingAgainLeft.set(relPath, goRebindAll ? 0 : at);
  }
  // A file given up on that is gone, or whose rows this run wrote anew, is
  // ordinary work again.
  for (const relPath of [...tree.goBindingAbandoned.keys()]) {
    if (deletedNow.has(relPath) || goRewritten.has(relPath)) {
      tree.goBindingAbandoned.delete(relPath);
    }
  }

  // ── What is left, and for how many more ingests it may be
  // ({@link GO_BINDING_RESUME_GRACE}) — decided BEFORE any row is written, so
  // that what is given up is written as given up.
  /** Files given up on that this run could not read: their rows are cleared by file. */
  const goGivenUpUnread: string[] = [];
  if (tree.goBindingLeft.size + tree.goBindingAgainLeft.size > 0) {
    // Re-planned: a Go change put every unchanged file back from its first
    // call, so the allowance is sized for the work as it is NOW — unless the
    // calls never resolved by type did not move, which is the stuck graph the
    // allowance exists to end.
    const neverResolvedMoved =
      tree.goBindingPending.size === 0 ||
      [...tree.goBindingPending].some(([file, at]) => tree.goBindingLeft.get(file) !== at);
    const fresh = tree.goBindingResumesLeft === null || (goRebindAll && neverResolvedMoved);
    let resumesLeft = fresh
      ? Math.ceil(goIncompleteCalls / Math.max(1, tree.goBindingMinCalls)) + GO_BINDING_RESUME_GRACE
      : tree.goBindingResumesLeft! - 1;
    if (resumesLeft <= 0) {
      // A call waiting to be resolved AGAIN holds a type answer from before
      // the last Go change. Given up, it must not keep it: undecided by type,
      // which is written like any other undecided call (the name rules).
      const read = new Map(affectedFiles.map((f) => [f.filePath, f]));
      for (const [relPath, from] of tree.goBindingAgainLeft) {
        const file = read.get(relPath);
        if (!file) {
          goGivenUpUnread.push(relPath);
          continue;
        }
        // From its recorded index on, step 1 had the file: never resolved.
        const to = tree.goBindingPending.get(relPath) ?? Number.POSITIVE_INFINITY;
        let index = -1;
        for (const edge of file.edges) {
          if (edge.kind !== "calls" || !edge.goCallee) continue;
          index += 1;
          if (index >= to) break;
          if (index >= from) goPlan.set(edge, GO_CALL_GIVEN_UP);
        }
      }
      for (const [file, at] of tree.goBindingAgainLeft) tree.goBindingAbandoned.set(file, at);
      for (const [file, at] of tree.goBindingLeft) tree.goBindingAbandoned.set(file, at);
      tree.goBindingEnd.abandonedNow = [
        ...tree.goBindingLeft.keys(),
        ...tree.goBindingAgainLeft.keys(),
      ];
      tree.goBindingLeft.clear();
      tree.goBindingAgainLeft.clear();
      resumesLeft = 0;
    }
    tree.goBindingEnd.resumesLeft = resumesLeft > 0 ? resumesLeft : null;
  }
  const persistedClassNames = await loadPersistedClassNames(
    prisma,
    codeGraphId,
    parsedFiles,
    index,
  );

  /** One parsed edge as a full ingest would persist it; null when it has no source symbol. */
  const resolveEdge = (file: ParsedFile, edge: ParsedFile["edges"][number]) => {
    const fromId = qnameToId.get(edge.fromQualifiedName);
    if (!fromId) return null; // Dropped: no source symbol — should not happen.
    const site = {
      filePath: file.filePath,
      language: file.language,
      importedFiles: importTargets.get(file.filePath) ?? [],
      runtimeImports: runtimeImports.get(file.filePath),
    };
    let toId: string | null = qnameToId.get(edge.toQualifiedName) ?? null;
    if (!toId && file.language === "cbl" && edge.kind === "imports") {
      // A copybook name is a file, never a symbol: an unresolved COPY stays unbound.
      const copybook = resolveCopybook(edge.toQualifiedName, file.filePath, importCtx.copybooks);
      toId = copybook ? (qnameToId.get(copybook) ?? null) : null;
    } else if (!toId && (goTyped || goPlan.has(edge)) && edge.goCallee && edge.kind === "calls") {
      // #1071 — a Go call is decided by the declared types first; the
      // name-evidence rules apply only where no type could be inferred. A call
      // the plan left out was resolved by an earlier run and not looked at again.
      const planned = goPlan.get(edge) ?? GO_CALL_NOT_RESOLVED;
      const verdict = planned.verdict;
      let resolution: GoResolution | null = null;
      if (verdict.kind === "bound") {
        toId = qnameToId.get(verdict.qualifiedName) ?? null;
        if (toId) resolution = verdict.via;
      } else if (verdict.kind === "unbound") {
        resolution = verdict.reason;
      } else {
        toId = resolveEdgeTarget(edge.toQualifiedName, edge.receiver, site, index);
        if (toId) resolution = GO_RESOLUTION_NAME;
      }
      return {
        fromSymbolId: fromId,
        kind: edge.kind as string,
        toSymbolId: toId,
        metadata: resolution ? goResolutionMetadata(resolution) : null,
        keepStored: planned.unresolved,
        upgrade: planned.upgrade === true,
      };
    } else if (!toId) {
      toId = resolveEdgeTarget(edge.toQualifiedName, edge.receiver, site, index);
    }
    // #170 — a capitalised Kotlin call is a constructor only if a class exists.
    const { kind, metadata } = reclassifyKotlinConstructorCall(
      edge,
      file.language,
      index,
      persistedClassNames,
    );
    return {
      fromSymbolId: fromId,
      kind,
      toSymbolId: toId,
      metadata: metadata ? JSON.stringify(metadata) : null,
      // A Go call no resolver could be BUILT for was not resolved by type either.
      keepStored: goBuilt.failed && edge.goCallee !== undefined,
      upgrade: false,
    };
  };

  // #1071 — an upgraded file's parser edges are rewritten whole rather than
  // matched row by row (pass 3): the older extractor could file an edge under
  // the wrong source symbol (two Go methods of one name in a file shared a
  // qualified name), which no (from, target, line) match would repair. Rows
  // other passes wrote for the file carry a `source` and are left alone.
  //
  // One file at a time, its old edges deleted in the SAME transaction as its
  // first batch of new ones: a reader (an impact analysis, a document capturing
  // its inputs) never sees a project whose Go files have symbols and no edges,
  // and a crash mid-upgrade leaves every file either old or new, never empty.
  for (const file of [...parsedFiles, ...upgradedFiles]) {
    // Edges carry no ids anyone needs back, so they go in multi-row inserts:
    // one statement (and one commit) per EDGE_INSERT_BATCH rows (#16).
    let batch: Prisma.CodeEdgeCreateManyInput[] = [];
    const upgrading = upgradedPaths.has(file.filePath);
    let replaceOld = upgrading;
    const flush = async (): Promise<void> => {
      const insert = batch.length > 0 ? [prisma.codeEdge.createMany({ data: batch })] : [];
      if (upgrading) {
        // Every write of the rewrite moves the graph's upgrade mark with it, so
        // whoever sees the rows changed also sees WHY (`extractor-upgrade.ts`).
        const writes: Prisma.PrismaPromise<unknown>[] = [];
        if (replaceOld) {
          replaceOld = false;
          writes.push(
            prisma.codeEdge.deleteMany({
              where: {
                codeGraphId,
                filePath: file.filePath,
                source: null,
                kind: { in: [...PARSER_EDGE_KINDS] },
              },
            }),
          );
        }
        writes.push(...insert);
        if (writes.length > 0) {
          writes.push(
            prisma.codeGraph.update({
              where: { id: codeGraphId },
              data: { extractorUpgradedAt: tree.nextUpgradeMark() },
            }),
          );
          await prisma.$transaction(writes);
        }
      } else if (insert.length > 0) {
        await insert[0];
      }
      stats.edgesUpserted += batch.length;
      batch = [];
    };
    for (const edge of file.edges) {
      await maybeYield();
      const resolved = resolveEdge(file, edge);
      if (!resolved) continue;
      batch.push({
        codeGraphId,
        projectId,
        fromSymbolId: resolved.fromSymbolId,
        kind: resolved.kind,
        toSymbolId: resolved.toSymbolId,
        metadata: resolved.metadata,
        toQualifiedName: edge.toQualifiedName,
        filePath: file.filePath,
        line: edge.line,
      });
      if (batch.length >= EDGE_INSERT_BATCH) await flush();
    }
    if (batch.length > 0 || replaceOld) await flush();
  }

  // ── Pass 3 (#313): re-bind the affected unchanged files' edges in place. Their
  // rows are matched to the re-parsed edges by (from, target name, line), in
  // creation order, so ids survive and nothing is duplicated. Rows another pass
  // wrote from the same file (`source` set, or a MyBatis call-site edge whose
  // target name no parser edge carries) match nothing and are left alone.
  for (const file of affectedFiles) {
    await maybeYield();
    const wanted = new Map<string, Array<NonNullable<ReturnType<typeof resolveEdge>>>>();
    for (const edge of file.edges) {
      const resolved = resolveEdge(file, edge);
      if (!resolved) continue;
      const key = edgeRowKey(resolved.fromSymbolId, edge.toQualifiedName, edge.line);
      const list = wanted.get(key);
      if (list) list.push(resolved);
      else wanted.set(key, [resolved]);
    }
    const rows = await prisma.codeEdge.findMany({
      where: { codeGraphId, filePath: file.filePath, source: null },
      select: {
        id: true,
        fromSymbolId: true,
        toQualifiedName: true,
        line: true,
        kind: true,
        toSymbolId: true,
        metadata: true,
      },
      orderBy: { id: "asc" },
    });
    const updates: Prisma.PrismaPromise<unknown>[] = [];
    let upgradeWrites = false;
    for (const row of rows) {
      const next = wanted.get(edgeRowKey(row.fromSymbolId, row.toQualifiedName, row.line))?.shift();
      if (!next) continue;
      // #1071 — a call this run did not resolve by type never replaces the
      // answer the row holds. The one exception is a row that names a binding
      // whose target is gone (its symbol was re-created): nothing is left to
      // keep, so the name-evidence answer is written.
      if (
        next.keepStored &&
        !(row.toSymbolId === null && row.metadata !== null && GO_BOUND_METADATA.has(row.metadata))
      ) {
        continue;
      }
      if (
        next.kind === row.kind &&
        next.toSymbolId === row.toSymbolId &&
        next.metadata === row.metadata
      ) {
        continue;
      }
      if (next.upgrade) upgradeWrites = true;
      updates.push(
        prisma.codeEdge.update({
          where: { id: row.id },
          data: { kind: next.kind, toSymbolId: next.toSymbolId, metadata: next.metadata },
        }),
      );
    }
    if (updates.length === 0) continue;
    if (upgradeWrites) {
      // Rows among these are the rest of an extractor upgrade's rewrite — a
      // call the upgrade's ceiling skipped, resolved now — so the graph's
      // upgrade mark moves with them like every other write of it. It moves
      // for NOTHING else: while the version is unstamped every re-bind used
      // to move it, whatever language the file was and whatever caused it,
      // which acknowledged real changes as upgrades on every ingest (PR #1104
      // review cycle 4).
      updates.push(
        prisma.codeGraph.update({
          where: { id: codeGraphId },
          data: { extractorUpgradedAt: tree.nextUpgradeMark() },
        }),
      );
    }
    await prisma.$transaction(updates);
  }

  if (goGivenUpUnread.length > 0) {
    // Given up in a file this run could not read: which of its rows predate
    // the last Go change cannot be told without its calls in order, so every
    // type verdict the file holds goes. Unbound and unlabelled is undecided.
    await prisma.codeEdge.updateMany({
      where: {
        codeGraphId,
        filePath: { in: goGivenUpUnread },
        kind: "calls",
        source: null,
        metadata: { in: [...GO_TYPE_METADATA] },
      },
      data: { toSymbolId: null, metadata: null },
    });
  }

  const goOpenFiles = new Set([...tree.goBindingLeft.keys(), ...tree.goBindingAgainLeft.keys()]);
  if (goBinding.files > 0 || goOpenFiles.size > 0) {
    stats.goBinding = {
      ...goBinding,
      stopReason: goStop.reason,
      heapGrowthMb:
        goStop.heapGrowth === null ? null : Math.round(goStop.heapGrowth / (1024 * 1024)),
      durationMs: Math.round(goParseMs + goResolveMs),
      incomplete:
        goOpenFiles.size > 0 ? { files: goOpenFiles.size, calls: goIncompleteCalls } : null,
      // Set in Step 8, once it is known whether this run gave anything up.
      abandonedFiles: 0,
    };
  }
}

/** The edge kinds the language parsers write (every other kind comes from a schema pass). */
const PARSER_EDGE_KINDS: ReadonlySet<string> = new Set([
  "calls",
  "imports",
  "defines",
  "references",
]);

/**
 * #1071 — the type resolver over every Go file whose declarations are in hand
 * (null when there are none), and how many files that is.
 *
 * A file is a test file by GO's rule — `_test.go` — and by nothing else: that
 * is what decides which declarations a caller can see. The code-graph's wider
 * convention (anything under `tests/`) would hide `tests/util/util.go` from the
 * packages that import it. Never throws: a resolver that cannot be built leaves
 * every Go call to the name-evidence rules, and is reported (`failed`).
 *
 * @param treeGoPaths every Go file the tree holds that this run tried to read.
 */
function buildGoResolver(
  files: readonly ParsedFile[],
  modules: readonly GoModule[],
  treeGoPaths: readonly string[],
): { resolver: GoResolver | null; files: number; failed: boolean } {
  const goFiles: GoResolverFile[] = [];
  for (const f of files) {
    if (f.language === "go" && f.goFacts) {
      goFiles.push({
        filePath: f.filePath,
        facts: f.goFacts,
        isTest: f.filePath.endsWith("_test.go"),
      });
    }
  }
  if (goFiles.length === 0) return { resolver: null, files: 0, failed: false };
  // A Go file of the tree whose declarations are not in hand (unreadable,
  // unparseable) leaves its directory's package incomplete.
  const have = new Set(goFiles.map((f) => f.filePath));
  const incompleteDirs = new Set<string>();
  for (const p of treeGoPaths) if (!have.has(p)) incompleteDirs.add(goDir(p));
  try {
    return {
      resolver: createGoResolver(goFiles, modules, { incompleteDirs }),
      files: goFiles.length,
      failed: false,
    };
  } catch {
    return { resolver: null, files: goFiles.length, failed: true };
  }
}

/** #1072 — the own-file context of each symbol of one file, in the order given. */
function ownContextsOf(
  filePath: string,
  language: string,
  sourceLines: readonly string[],
  symbols: readonly ContextSourceSymbol[],
): OwnFileContext[] {
  const file = { filePath, language, package: packageOfFile(filePath, language, sourceLines) };
  return symbols.map((sym) => extractOwnFileContext(sym, file, sourceLines));
}

/**
 * The text a symbol is embedded from: its header, the context lines production
 * ships (#1072, ADR 0020), and the lines of its span. One function for the two
 * writers — a parsed file (pass 1) and the backfill of an unchanged one — so a
 * symbol's text does not depend on which of them wrote it.
 */
function embeddingTextOf(
  sym: { id: string; name: string; qualifiedName: string; kind: string } & Pick<
    ContextSourceSymbol,
    "startLine" | "endLine"
  >,
  filePath: string,
  own: OwnFileContext,
  sourceLines: readonly string[],
): string {
  return formatSymbolForEmbedding({
    symbolId: sym.id,
    name: sym.name,
    qualifiedName: sym.qualifiedName,
    kind: sym.kind as EmbeddingSymbolKind,
    filePath,
    contextLines: shippedContextLines(own),
    bodyLines: sourceLines.slice(sym.startLine - 1, sym.endLine),
  });
}

/**
 * #1072 — fill in the context columns of every UNCHANGED file's symbols, for a
 * graph written before {@link SYMBOL_CONTEXT_VERSION}.
 *
 * Nothing is re-parsed and no row is re-created (#856): a stored symbol already
 * has its kind, qualified name and line span, the file's content is the content
 * those were read from (its hash is checked again here), and that is all
 * {@link extractOwnFileContext} needs. So every id survives, and with it every
 * finding, mapping and vector that points at one.
 *
 * An embedding text that comes out different is rewritten and marked PENDING
 * (`embeddingModel` empty), which is what makes the embed job embed that symbol
 * again; one whose text is unchanged is not touched and is not embedded again.
 * The comparison is by content hash, so no stored text is read.
 *
 * Idempotent: a second run over the same files writes nothing. A file that
 * cannot be read, or whose content is no longer the one the walk hashed, is
 * counted in `failedFiles` and left as it was.
 *
 * Rows a schema pass wrote for the file (`source` set) are not parser symbols
 * and are left alone.
 */
export async function backfillSymbolContext(
  prisma: PrismaClient,
  codeGraphId: string,
  rootDir: string,
  unchangedFiles: ReadonlyMap<string, { language: string; contentHash: string }>,
  maybeYield: MaybeYield,
): Promise<{ symbols: number; embeddingTexts: number; failedFiles: number }> {
  const done = { symbols: 0, embeddingTexts: 0, failedFiles: 0 };
  for (const [relPath, { language, contentHash }] of unchangedFiles) {
    await maybeYield();
    let source: string;
    try {
      source = stripNulBytes(await fs.readFile(path.join(rootDir, relPath), "utf8"));
    } catch {
      done.failedFiles += 1;
      continue;
    }
    if (sha256(source) !== contentHash) {
      // Edited since the walk read it: the stored spans describe the old content.
      done.failedFiles += 1;
      continue;
    }
    const rows = await prisma.codeSymbol.findMany({
      where: { codeGraphId, filePath: relPath, source: null, language },
      select: {
        id: true,
        kind: true,
        name: true,
        qualifiedName: true,
        startLine: true,
        endLine: true,
        signature: true,
        docComment: true,
        receiver: true,
        package: true,
        embedding: { select: { contentHash: true } },
      },
    });
    const sourceLines = source.split("\n");
    const contexts = ownContextsOf(relPath, language, sourceLines, rows);
    const writes: Prisma.PrismaPromise<unknown>[] = [];
    for (const [i, row] of rows.entries()) {
      const own = contexts[i];
      if (
        own.signature !== row.signature ||
        own.docComment !== row.docComment ||
        own.receiver !== row.receiver ||
        own.package !== row.package
      ) {
        writes.push(prisma.codeSymbol.update({ where: { id: row.id }, data: own }));
        done.symbols += 1;
      }
      if (!row.embedding) continue;
      const text = embeddingTextOf(row, relPath, own, sourceLines);
      const hash = computeSymbolHash(text);
      if (hash === row.embedding.contentHash) continue;
      writes.push(
        prisma.codeSymbolEmbedding.update({
          where: { symbolId: row.id },
          data: { text, contentHash: hash, embeddingModel: "" },
        }),
      );
      done.embeddingTexts += 1;
    }
    // One transaction per file (#16): a row and its embedding text move together.
    if (writes.length > 0) await prisma.$transaction(writes);
  }
  return done;
}

/**
 * #1071 — give a file's stored symbols the qualified names the current parser
 * produces, on the existing rows. A stored symbol is matched to a re-parsed one
 * by kind, name and start line — all three unchanged, since the file's content
 * is. Rows a schema pass wrote for the file (`source` set, or another language)
 * match nothing.
 *
 * The same transaction rewrites the two tables that keep a symbol's qualified
 * name as TEXT beside (or instead of) its id, so a stored impact run still
 * names the symbol the graph does: `impact_affected_symbols.qualifiedName`
 * (by `codeSymbolId` — without this an impact re-run reports every renamed
 * method as removed and added) and `impact_column_proposals.writerQualifiedName`
 * (no symbol id: by file, old name and start line, within this project — and
 * by primary key, from the one read {@link loadColumnProposalWriters} made).
 * It also moves `CodeGraph.extractorUpgradedAt`, so a reader that sees the
 * renamed rows sees that an upgrade made them.
 */
async function renameSymbolsInPlace(
  prisma: PrismaClient,
  codeGraphId: string,
  file: ParsedFile,
  proposals: ColumnProposalWriters,
  nextUpgradeMark: () => Date,
): Promise<void> {
  const rows = await prisma.codeSymbol.findMany({
    where: { codeGraphId, filePath: file.filePath, source: null, language: file.language },
    select: {
      id: true,
      projectId: true,
      kind: true,
      name: true,
      startLine: true,
      qualifiedName: true,
    },
  });
  const wanted = new Map<string, string>();
  for (const sym of file.symbols) {
    wanted.set(`${sym.kind}\u0000${sym.name}\u0000${sym.startLine}`, sym.qualifiedName);
  }
  const inFile = proposals.get(file.filePath);
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  for (const row of rows) {
    const next = wanted.get(`${row.kind}\u0000${row.name}\u0000${row.startLine}`);
    if (next === undefined || next === row.qualifiedName) continue;
    updates.push(
      prisma.codeSymbol.update({
        where: { id: row.id },
        // #1072 — the receiver is read off the qualified name, so it moves with it.
        data: {
          qualifiedName: next,
          receiver: receiverOf(
            { kind: row.kind, qualifiedName: next },
            file.filePath,
            file.language,
          ),
        },
      }),
      prisma.impactAffectedSymbol.updateMany({
        where: { codeSymbolId: row.id },
        data: { qualifiedName: next },
      }),
    );
    const ids = inFile?.get(proposalWriterKey(row.qualifiedName, row.startLine));
    if (ids) {
      updates.push(
        prisma.impactColumnProposal.updateMany({
          where: { id: { in: ids } },
          data: { writerQualifiedName: next },
        }),
      );
    }
  }
  if (updates.length === 0) return;
  // The rename and the graph's upgrade mark move together (`extractor-upgrade.ts`).
  updates.push(
    prisma.codeGraph.update({
      where: { id: codeGraphId },
      data: { extractorUpgradedAt: nextUpgradeMark() },
    }),
  );
  await prisma.$transaction(updates);
}

/** Writer file → (`qualifiedName` + start line) → the ids of the column proposals naming that writer. */
type ColumnProposalWriters = Map<string, Map<string, string[]>>;

const proposalWriterKey = (qualifiedName: string, startLine: number | null): string =>
  `${qualifiedName}\u0000${startLine ?? ""}`;

/**
 * #1071 — every column proposal of the project that names a writer, read
 * ONCE. `impact_column_proposals` has no index on the writer columns, so
 * looking a renamed symbol up there is a scan of the table — once per renamed
 * symbol (904 on the Miniflux sample) before this.
 */
async function loadColumnProposalWriters(
  prisma: PrismaClient,
  projectId: string,
): Promise<ColumnProposalWriters> {
  const rows = await prisma.impactColumnProposal.findMany({
    where: {
      impactItem: { projectId },
      writerQualifiedName: { not: null },
      writerFilePath: { not: null },
    },
    select: { id: true, writerQualifiedName: true, writerFilePath: true, writerStartLine: true },
  });
  const out: ColumnProposalWriters = new Map();
  for (const row of rows) {
    if (row.writerQualifiedName === null || row.writerFilePath === null) continue;
    let ofFile = out.get(row.writerFilePath);
    if (!ofFile) {
      ofFile = new Map();
      out.set(row.writerFilePath, ofFile);
    }
    const key = proposalWriterKey(row.writerQualifiedName, row.writerStartLine);
    const ids = ofFile.get(key);
    if (ids) ids.push(row.id);
    else ofFile.set(key, [row.id]);
  }
  return out;
}

function edgeRowKey(fromSymbolId: string, toQualifiedName: string | null, line: number): string {
  return `${fromSymbolId}\u0000${toQualifiedName ?? ""}\u0000${line}`;
}

/**
 * #313 pass 0 — before the changed files' symbols are re-created: the names and
 * qualified names they (and deleted files) defined, and the unchanged files
 * holding an edge bound to one of those symbols.
 */
async function loadPreviousTargets(
  prisma: PrismaClient,
  codeGraphId: string,
  changedPaths: string[],
  unchangedFiles: ReadonlyMap<string, unknown>,
): Promise<{ names: Set<string>; affected: Set<string> }> {
  const names = new Set<string>();
  const affected = new Set<string>();
  for (let k = 0; k < changedPaths.length; k += IN_LIST_CHUNK) {
    const symbols = await prisma.codeSymbol.findMany({
      where: { codeGraphId, filePath: { in: changedPaths.slice(k, k + IN_LIST_CHUNK) } },
      select: { id: true, name: true, qualifiedName: true },
    });
    for (const s of symbols) {
      names.add(s.name);
      names.add(s.qualifiedName);
    }
    const ids = symbols.map((s) => s.id);
    for (let j = 0; j < ids.length; j += IN_LIST_CHUNK) {
      const edges = await prisma.codeEdge.findMany({
        where: { codeGraphId, source: null, toSymbolId: { in: ids.slice(j, j + IN_LIST_CHUNK) } },
        select: { filePath: true },
        distinct: ["filePath"],
      });
      for (const e of edges) if (unchangedFiles.has(e.filePath)) affected.add(e.filePath);
    }
  }
  return { names, affected };
}

/** #313 — the files holding a parser edge whose target name is one of `names`. */
async function filesReferencing(
  prisma: PrismaClient,
  codeGraphId: string,
  names: ReadonlySet<string>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const list = [...names];
  for (let k = 0; k < list.length; k += IN_LIST_CHUNK) {
    const edges = await prisma.codeEdge.findMany({
      where: {
        codeGraphId,
        source: null,
        toQualifiedName: { in: list.slice(k, k + IN_LIST_CHUNK) },
      },
      select: { filePath: true },
      distinct: ["filePath"],
    });
    for (const e of edges) out.add(e.filePath);
  }
  return out;
}

/**
 * #313 — re-parse an unchanged file to recover what its persisted edges do not
 * keep (call receivers, runtime-imported names). When it can no longer be read
 * or parsed its edges are left as they are, and the caller is told which.
 */
async function reparseUnchanged(
  tree: IngestTreeState,
  relPath: string,
): Promise<ParsedFile | "unreadable" | "unparseable"> {
  const lang = detectLanguage(relPath);
  if (!lang) return "unreadable";
  let source: string;
  try {
    source = stripNulBytes(await fs.readFile(path.join(tree.rootDir, relPath), "utf8"));
  } catch {
    return "unreadable";
  }
  const parsed = parseSource(relPath, source, lang);
  return parsed.unparseable ? "unparseable" : parsed;
}

/**
 * #170 review — the names of Kotlin/Java classes, among this run's candidate
 * Kotlin constructor calls, that exist in the graph but not in the in-memory
 * index. On an incremental ingest the index holds only re-parsed files, so
 * without this `Order(1)` would become a `calls` edge whenever `Order.kt` is
 * unchanged, and flip back on the next full ingest. One query per
 * {@link CLASS_NAME_QUERY_CHUNK} unresolved candidate names, none when there are none.
 */
async function loadPersistedClassNames(
  prisma: PrismaClient,
  codeGraphId: string,
  parsedFiles: ParsedFile[],
  index: ResolutionIndex,
): Promise<Set<string>> {
  const unresolved = new Set<string>();
  for (const file of parsedFiles) {
    for (const edge of file.edges) {
      if (!isKotlinConstructorCandidate(edge, file.language)) continue;
      const known = (index.nameToSymbols.get(edge.toQualifiedName) ?? []).some(
        (s) => s.kind === "class" && KOTLIN_CONSTRUCTIBLE_LANGUAGES.has(s.language),
      );
      if (!known) unresolved.add(edge.toQualifiedName);
    }
  }
  const found = new Set<string>();
  const names = [...unresolved];
  for (let k = 0; k < names.length; k += CLASS_NAME_QUERY_CHUNK) {
    const rows = await prisma.codeSymbol.findMany({
      where: {
        codeGraphId,
        kind: "class",
        name: { in: names.slice(k, k + CLASS_NAME_QUERY_CHUNK) },
        language: { in: [...KOTLIN_CONSTRUCTIBLE_LANGUAGES] },
      },
      select: { name: true },
    });
    for (const r of rows) found.add(r.name);
  }
  return found;
}

/** Names per `IN (...)` list in {@link loadPersistedClassNames} — under SQLite's bound-variable limit. */
const CLASS_NAME_QUERY_CHUNK = 500;

/** Values per `IN (...)` list in the #313 incremental-edge queries — same limit. */
const IN_LIST_CHUNK = 500;

/** #856 — the synthetic origin a Step 6 extractor writes when no function encloses the SQL. */
const LINEAGE_ORIGIN = /::(?:sql|exec|procsql)@\d+$/;

/**
 * #856 — remove what Step 6 wrote for files a lineage backfill re-extracts
 * without re-parsing: their `sqlglot` edges, their synthetic `sql@`/`exec@`/
 * `procsql@` origins. Table, column and (#867) routine symbols stay, so their
 * ids survive for the edges the backfill rewrites (and
 * any other pass's edges into them); {@link pruneOrphanLineageSymbols} removes
 * the ones nothing points at afterwards. Parser rows are never touched.
 */
async function clearFileLineage(
  prisma: PrismaClient,
  codeGraphId: string,
  filePaths: readonly string[],
): Promise<void> {
  for (let k = 0; k < filePaths.length; k += IN_LIST_CHUNK) {
    const chunk = filePaths.slice(k, k + IN_LIST_CHUNK);
    await prisma.codeEdge.deleteMany({
      where: { codeGraphId, filePath: { in: chunk }, source: "sqlglot" },
    });
    const candidates = await prisma.codeSymbol.findMany({
      where: { codeGraphId, filePath: { in: chunk }, language: "sql" },
      select: { id: true, kind: true, qualifiedName: true, filePath: true, source: true },
    });
    // #867 — routines are kept, like tables and columns: a `catalog-deps` edge
    // may point at one, and that pass is not rewritten on every ingest.
    const stale = candidates
      .filter(
        (s) =>
          s.source === null &&
          s.kind === "method" &&
          s.qualifiedName.startsWith(`${s.filePath}::`) &&
          LINEAGE_ORIGIN.test(s.qualifiedName),
      )
      .map((s) => s.id);
    for (let j = 0; j < stale.length; j += IN_LIST_CHUNK) {
      await prisma.codeSymbol.deleteMany({
        where: { codeGraphId, id: { in: stale.slice(j, j + IN_LIST_CHUNK) } },
      });
    }
  }
}

/**
 * #856 — after a lineage backfill, drop the `sqlglot` table/column/routine symbols filed
 * under its re-extracted files that no edge points at (or, for a routine, leaves) any more: the columns a
 * dropped schema no longer expands to, or every lineage symbol once lineage is
 * turned off. A full re-parse removed these with the file's other rows.
 */
async function pruneOrphanLineageSymbols(
  prisma: PrismaClient,
  codeGraphId: string,
  filePaths: readonly string[],
): Promise<void> {
  for (let k = 0; k < filePaths.length; k += IN_LIST_CHUNK) {
    const chunk = filePaths.slice(k, k + IN_LIST_CHUNK);
    const ids = (
      await prisma.codeSymbol.findMany({
        where: {
          codeGraphId,
          filePath: { in: chunk },
          source: "sqlglot",
          kind: { in: ["table", "column", "procedure", "function"] },
        },
        select: { id: true },
      })
    ).map((s) => s.id);
    for (let j = 0; j < ids.length; j += IN_LIST_CHUNK) {
      const slice = ids.slice(j, j + IN_LIST_CHUNK);
      // A routine with an edge out of it (a body's `calls`) is in use too.
      const edges = await prisma.codeEdge.findMany({
        where: {
          codeGraphId,
          OR: [{ toSymbolId: { in: slice } }, { fromSymbolId: { in: slice } }],
        },
        select: { toSymbolId: true, fromSymbolId: true },
      });
      const referenced = new Set(edges.flatMap((e) => [e.toSymbolId, e.fromSymbolId]));
      const orphans = slice.filter((id) => !referenced.has(id));
      if (orphans.length > 0) {
        await prisma.codeSymbol.deleteMany({ where: { codeGraphId, id: { in: orphans } } });
      }
    }
  }
}

/** Rows per `codeEdge.createMany` in {@link persistParsed} (#16). */
const EDGE_INSERT_BATCH = 500;

export interface SchemaUsageWiring {
  /** Introspected schema for SELECT* expansion / column accuracy (#317). */
  schema?: IntrospectedSchema | null;
  /** Live routines whose bodies feed `calls` edges (#316B). */
  routines?: DbRoutineInfo[];
  /** READ-ONLY routine-body fetcher (#316B). */
  fetchRoutineBody?: RoutineBodyFetcher;
  /** Dialect hint for routine-body parsing (#316B). */
  routineDialect?: string;
  /** Live PL/SQL packages whose bodies feed Tier-2 member-level edges (#893, wired by #953). */
  packages?: DbPackageInfo[];
  /** READ-ONLY PL/SQL package-body fetcher (#953). */
  fetchPackageBody?: PackageBodyFetcher;
  /** Coarse Tier-1 catalog-dependency rows (#890), threaded in by #894. */
  dependencies?: DbDependencyInfo[];
  /** Resolved per-project SQL-lineage override (#894). */
  sqlLineageOverride?: boolean | null;
  /**
   * #856 — unchanged files a lineage backfill re-extracts without re-parsing.
   * When non-empty the writer is seeded with the graph's persisted `table`/
   * `column` symbols, so it reuses their ids rather than writing duplicates
   * beside the rows it kept; and the `sqlglot` symbols filed under these files
   * are left out of the #901 graph-derived schema, as a full re-parse (which
   * deletes them first) would leave them out.
   */
  lineageRefreshPaths?: ReadonlySet<string>;
  /**
   * Inject a sql-lineage client (tests only) — threaded into the routine-body
   * and PL/SQL package-lineage passes so an ingest-level test can exercise the
   * real entry path without a live sidecar. Production leaves this undefined and
   * the env-configured singleton is used.
   */
  client?: SqlLineageClient;
}

/**
 * Step 6 — schema-usage extraction (#305 embedded SQL, #306 SAS PROC SQL, #316
 * routine `executes`/`calls` edges), feeding the introspected schema (#317).
 *
 * For every freshly-parsed file, dispatch by language to the matching SQL-lineage
 * extractor so that table/column references embedded in application code (TS / JS
 * / Python / Go string literals) and SAS `PROC SQL` blocks are written into the
 * SAME schema graph (`source = "sqlglot"`) as the MyBatis/ORM/DDL extractors —
 * flowing through the existing reconciler/classifier downstream. The same per-file
 * scan also detects routine INVOCATIONS (`CALL`/`EXEC`/`SELECT fn()`) and emits
 * code→routine `executes` edges (#316A). When live routines + a read-only body
 * fetcher are supplied, routine BODIES are parsed once into routine→object `calls`
 * edges (#316B).
 *
 * Contract (the #294 requirements):
 *   - **Feature-gated, per-project (#894).** Short-circuits when the resolved
 *     decision — `wiring.sqlLineageOverride` when the caller resolved a
 *     per-project setting, else the platform `SQL_LINEAGE_MODE != sidecar`
 *     default ({@link isSqlLineageEnabled}) — is disabled; the per-statement
 *     {@link extractUsageSafe} call also re-checks the SAME gate, so nothing
 *     is shipped to a disabled sidecar.
 *   - **Graceful degradation.** The whole step is wrapped so a sidecar that is
 *     down/erroring (or any extractor throw) can NEVER fail or block ingest — it
 *     simply produces zero `sqlglot` edges and ingest continues.
 *   - **Additive.** The SAS data-step miner (`mineSasRules`) is untouched; only
 *     the SQL *inside* PROC SQL blocks is routed here.
 *   - **Schema-fed (#317).** The introspected schema is threaded into EVERY
 *     extractor call; when absent (no DB connection) the extractors get `null` and
 *     behave exactly as before — table-level + explicitly-named-column edges only.
 *   - **Routine bodies parse-only (#316B).** Bodies are fetched READ-ONLY and only
 *     PARSED by the sidecar — never executed; unresolved bodies stay `uncertain`.
 *   - **Tier-1 catalog dependencies (#890/#894).** When `wiring.dependencies`
 *     is supplied, coarse zero-parse `catalog-deps` `calls` edges are written
 *     via {@link extractRoutineDependencies} — no sidecar call, gated by the
 *     SAME per-project decision as everything else in this step.
 */
/** Is this an ORM schema file the ingest walk must capture despite having no tree-sitter language? */
export function isOrmSchemaFile(filePath: string): boolean {
  return /\.prisma$/i.test(filePath);
}

/**
 * ORM schema-extraction pass (#849) — turns captured ORM model files into the
 * schema graph (`table`/`column` symbols + `persists-to` edges) via the real
 * {@link persistOrmFile}. Wired into every ingest so the schema graph is populated
 * for ORM projects (Prisma/JPA) with no live DB required — closing the gap where
 * the extractor existed but was never called from {@link ingestCodeGraph}.
 *
 * Idempotent: parsed ORM files (JPA `.java`) were already wiped+repopulated by
 * {@link persistParsed}; non-parsed ORM files (`schema.prisma`) are wiped here
 * before re-persisting so a re-ingest never duplicates schema symbols. Never
 * throws — an ORM problem must not fail ingest.
 */
export async function extractOrmSchema(
  prisma: PrismaClient,
  codeGraphId: string,
  projectId: string,
  ormSources: Map<string, string>,
  parsedFiles: ParsedFile[],
  stats: IngestStats,
  sourceByRelPath: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  if (ormSources.size === 0) return;
  try {
    // Only non-parsed ORM paths need an explicit wipe; parsed paths (JPA `.java`)
    // were already cleared by persistParsed — re-wiping them would delete the
    // freshly-persisted tree-sitter symbols that share the same filePath.
    //
    // #872 — table/column symbols are EXCLUDED from the wipe (and prewarmed into
    // the writer below) so their ids stay STABLE across ingests: ORM call-site
    // edges from files NOT re-parsed on an incremental ingest keep pointing at
    // them, and recreating the tables would dangle those edges. Only the
    // synthetic per-model origin symbols + their `persists-to` edges are
    // rewritten per ingest.
    const parsedPaths = new Set(parsedFiles.map((f) => f.filePath));
    const nonParsedPaths = [...ormSources.keys()].filter((p) => !parsedPaths.has(p));
    if (nonParsedPaths.length > 0) {
      await prisma.codeEdge.deleteMany({
        where: { codeGraphId, filePath: { in: nonParsedPaths } },
      });
      await prisma.codeSymbol.deleteMany({
        where: {
          codeGraphId,
          filePath: { in: nonParsedPaths },
          kind: { notIn: ["table", "column"] },
        },
      });
    }
    const writer = new SchemaGraphWriter(
      prisma as unknown as ConstructorParameters<typeof SchemaGraphWriter>[0],
      codeGraphId,
      projectId,
    );
    const existingSchemaSymbols = await prisma.codeSymbol.findMany({
      where: { codeGraphId, kind: { in: ["table", "column"] } },
      select: { id: true, kind: true, qualifiedName: true },
    });
    writer.prewarm(existingSchemaSymbols);
    for (const [relPath, source] of ormSources) {
      try {
        stats.schemaEdges += await persistOrmFile(writer, relPath, source);
      } catch {
        // Per-file ORM extraction failure never aborts the rest of the run.
      }
    }

    // #872 — connect APPLICATION CODE to the schema graph: scan the re-parsed
    // TS/JS files for Prisma delegate call sites (`<recv>.<modelProp>.<op>(...)`)
    // and emit `reads`/`writes` edges from the enclosing PERSISTED code symbol to
    // the model's table. persistParsed already wiped all edges for re-parsed file
    // paths, so this pass is naturally idempotent per file; unchanged files keep
    // their prior edges (valid thanks to the stable table ids above).
    const models = buildOrmModelTableMap(ormSources);
    if (models.size > 0) {
      const candidates = parsedFiles.filter(
        (f) =>
          (f.language === "ts" || f.language === "js") &&
          sourceByRelPath.has(f.filePath) &&
          findOrmCallSites(sourceByRelPath.get(f.filePath) as string, models).length > 0,
      );
      if (candidates.length > 0) {
        const symbolsByFile = await loadEnclosingFunctionSymbols(
          prisma,
          codeGraphId,
          candidates.map((f) => f.filePath),
        );
        for (const file of candidates) {
          try {
            stats.schemaEdges += await persistOrmCallSiteEdges(
              writer,
              file.filePath,
              sourceByRelPath.get(file.filePath) as string,
              models,
              symbolsByFile.get(file.filePath) ?? [],
            );
          } catch {
            // Per-file call-site failure never aborts the rest of the run.
          }
        }
      }
    }
  } catch {
    // Writer construction / wipe failure — degrade to no ORM schema edges.
  }
}

/**
 * JPA/Hibernate query-lineage extraction pass (#896) — resolves HQL/JPQL
 * `@Query` annotations and Spring Data derived-query method names on
 * repository interfaces to the physical table/column their entity maps onto,
 * via the framework-agnostic {@link EntityTableResolver}
 * (`entity-resolver.ts`). Runs on EVERY ingest (pure static parsing, no
 * sidecar, no live DB) — like the ORM and MyBatis passes — immediately AFTER
 * {@link extractOrmSchema} so entity tables/columns it just created this
 * ingest are already prewarmed and the two passes never fork the same
 * physical table into two symbol rows.
 *
 * `ormSources` already carries EVERY captured `.java` file (entities AND
 * repository interfaces alike — captured unconditionally in the walk above),
 * so no extra source map is needed; this pass simply filters to `.java`.
 * Every synthetic query-origin symbol and its edges live on the SAME file
 * path as the repository interface's own real symbols, which
 * {@link persistParsed} already wiped + repopulated this ingest — so, like
 * the MyBatis annotation-`.java` case, no additional wipe is needed here for
 * idempotency. Never throws — a JPA query-lineage problem must not fail
 * ingest.
 */
export async function extractJpaQuerySchema(
  prisma: PrismaClient,
  codeGraphId: string,
  projectId: string,
  ormSources: ReadonlyMap<string, string>,
  stats: IngestStats,
): Promise<void> {
  const javaSources = new Map([...ormSources].filter(([relPath]) => /\.java$/i.test(relPath)));
  if (javaSources.size === 0) return;
  try {
    const resolver = buildJpaEntityResolver(javaSources);
    const writer = new SchemaGraphWriter(
      prisma as unknown as ConstructorParameters<typeof SchemaGraphWriter>[0],
      codeGraphId,
      projectId,
    );
    // Re-queried AFTER extractOrmSchema so entity tables/columns it just
    // created this ingest are already prewarmed here too.
    const existingSchemaSymbols = await prisma.codeSymbol.findMany({
      where: { codeGraphId, kind: { in: ["table", "column"] } },
      select: { id: true, kind: true, qualifiedName: true },
    });
    writer.prewarm(existingSchemaSymbols);

    const origins: JpaQueryOrigin[] = [];
    for (const [relPath, source] of javaSources) {
      try {
        stats.schemaEdges += await persistJpaQueryFile(writer, resolver, relPath, source, origins);
      } catch {
        // Per-file JPA query extraction failure never aborts the rest of the run.
      }
    }

    if (origins.length > 0) {
      const methodSymbolsByFile = await buildMapperMethodSymbolIndex(
        prisma as unknown as Parameters<typeof buildMapperMethodSymbolIndex>[0],
        codeGraphId,
        [...new Set(origins.map((o) => o.filePath))],
      );
      try {
        stats.schemaEdges += await persistJpaQueryOriginEdges(writer, origins, methodSymbolsByFile);
      } catch {
        // Origin correlation failure never aborts the rest of the run.
      }
    }
  } catch {
    // Writer construction failure — degrade to no JPA query-lineage edges.
  }
}

/** Is this a MyBatis XML mapper candidate the ingest walk must capture despite having no tree-sitter language? */
export function isMyBatisXmlFile(filePath: string): boolean {
  return /\.xml$/i.test(filePath);
}

/**
 * MyBatis schema-extraction pass (#884) — turns captured MyBatis mapper files
 * (XML `<mapper>` statements, `.java` `@Select`/`@Insert`/`@Update`/`@Delete`
 * annotation interfaces) into the schema graph (`table`/`column` symbols +
 * `reads`/`writes`/`persists-to` edges) via the real {@link persistMyBatisFile}.
 * Wired into every ingest so the schema graph is populated for MyBatis projects
 * with no live DB required — closing the gap where the extractor existed
 * (Epic #168 / #170) but was never called from {@link ingestCodeGraph}.
 *
 * Unlike {@link extractOrmSchema}, MyBatis statements each get their own
 * synthetic origin symbol (one per `<select>`/`<insert>`/`<update>`/`<delete>`
 * statement or annotated method — see {@link persistMyBatisFile}) with edges
 * pointing directly from that origin to the tables/columns the statement's SQL
 * touches. Issue #887 adds a call-site correlation pass ON TOP of that origin
 * (mirroring the ORM #872 phase, but two hops instead of one): the statement's
 * `namespace`/`statementId` (the mapper interface's FQCN + method name) is
 * resolved to the REAL Java interface method symbol
 * ({@link persistMyBatisStatementOriginEdges}, an `executes` edge from that
 * real method to the statement's synthetic origin), and Java call sites
 * invoking a known mapper interface's methods are connected to that same real
 * method symbol ({@link persistMapperCallerEdges}, an ordinary `calls` edge).
 * Together: `service → (calls) → interface method → (executes) → statement
 * origin → (reads/writes/persists-to) → table`.
 *
 * Idempotent: parsed MyBatis files (annotation `.java`) were already wiped +
 * repopulated by {@link persistParsed}; non-parsed MyBatis files (`.xml`
 * mappers) are wiped here before re-persisting so a re-ingest never
 * duplicates schema symbols. Table/column symbols are excluded from the wipe
 * (and prewarmed into the writer below) so their ids stay stable across
 * ingests, mirroring the ORM pass. Never throws — a MyBatis problem must not
 * fail ingest.
 */
export async function extractMyBatisSchema(
  prisma: PrismaClient,
  codeGraphId: string,
  projectId: string,
  myBatisSources: Map<string, string>,
  parsedFiles: ParsedFile[],
  stats: IngestStats,
): Promise<void> {
  if (myBatisSources.size === 0) return;
  try {
    const parsedPaths = new Set(parsedFiles.map((f) => f.filePath));
    const nonParsedPaths = [...myBatisSources.keys()].filter((p) => !parsedPaths.has(p));
    if (nonParsedPaths.length > 0) {
      await prisma.codeEdge.deleteMany({
        where: { codeGraphId, filePath: { in: nonParsedPaths } },
      });
      await prisma.codeSymbol.deleteMany({
        where: {
          codeGraphId,
          filePath: { in: nonParsedPaths },
          kind: { notIn: ["table", "column"] },
        },
      });
    }
    const writer = new SchemaGraphWriter(
      prisma as unknown as ConstructorParameters<typeof SchemaGraphWriter>[0],
      codeGraphId,
      projectId,
    );
    // Re-queried AFTER extractOrmSchema (Step 5c runs after Step 5b) so tables the
    // ORM pass just created this ingest are already prewarmed here too — the two
    // extractors never fork the same physical table into two symbol rows.
    const existingSchemaSymbols = await prisma.codeSymbol.findMany({
      where: { codeGraphId, kind: { in: ["table", "column"] } },
      select: { id: true, kind: true, qualifiedName: true },
    });
    writer.prewarm(existingSchemaSymbols);
    const origins: MyBatisStatementOrigin[] = [];
    for (const [relPath, source] of myBatisSources) {
      try {
        stats.schemaEdges += await persistMyBatisFile(writer, relPath, source, origins);
      } catch {
        // Per-file MyBatis extraction failure never aborts the rest of the run.
      }
    }

    // #887 — connect the statement origins to their REAL Java mapper interface
    // methods, and connect Java call sites to those same methods, so a
    // requirement crossing into service code reaches the statement's tables:
    // `service → (calls) → interface method → (executes) → statement origin →
    // (reads/writes/persists-to) → table`. `myBatisSources` already carries
    // EVERY captured `.java` file's source (mapper interfaces AND callers —
    // captured unconditionally above), so no extra source map is needed.
    const javaMapperIndex = buildJavaMapperIndex(myBatisSources);
    if (javaMapperIndex.size > 0) {
      const mapperFilePaths = [...new Set([...javaMapperIndex.values()].map((m) => m.filePath))];
      const methodSymbolsByFile = await buildMapperMethodSymbolIndex(
        prisma as unknown as Parameters<typeof buildMapperMethodSymbolIndex>[0],
        codeGraphId,
        mapperFilePaths,
      );
      try {
        stats.schemaEdges += await persistMyBatisStatementOriginEdges(
          writer,
          origins,
          javaMapperIndex,
          methodSymbolsByFile,
        );
      } catch {
        // Statement→interface correlation failure never aborts the rest of the run.
      }

      const methodsBySimpleName = buildMapperMethodsBySimpleName(
        javaMapperIndex,
        methodSymbolsByFile,
      );
      if (methodsBySimpleName.size > 0) {
        const candidates = parsedFiles.filter(
          (f) => f.language === "java" && myBatisSources.has(f.filePath),
        );
        if (candidates.length > 0) {
          const callerSymbolsByFile = await loadEnclosingFunctionSymbols(
            prisma,
            codeGraphId,
            candidates.map((f) => f.filePath),
          );
          for (const file of candidates) {
            try {
              stats.schemaEdges += await persistMapperCallerEdges(
                prisma as unknown as Parameters<typeof persistMapperCallerEdges>[0],
                codeGraphId,
                projectId,
                file.filePath,
                myBatisSources.get(file.filePath) as string,
                methodsBySimpleName,
                callerSymbolsByFile.get(file.filePath) ?? [],
              );
            } catch {
              // Per-file caller-edge failure never aborts the rest of the run.
            }
          }
        }
      }
    }
  } catch {
    // Writer construction / wipe failure — degrade to no MyBatis schema edges.
  }
}

/**
 * jOOQ generated table-class lineage pass (#897, Epic #883) — resolves
 * captured generated `TableImpl` classes' self-registering constants to their
 * physical tables and scans the SAME `.java` files for `DSLContext` call
 * sites (`.from(BOOK)`, `.insertInto(BOOK)`, ...), emitting `reads`/`writes`
 * edges from the REAL enclosing Java method/function symbol
 * (`persistJooqCallSiteEdges`) — the two-input, single-pass Java analogue of
 * {@link extractOrmSchema}'s TS/JS Prisma call-site half (#872). Unlike the
 * ORM/MyBatis schema passes, a generated table class that no application
 * code queries produces NO symbol or edge — jOOQ table classes are
 * query-builder handles, not persistence declarations, so there is nothing
 * to record until code actually references them. All `.java` files were
 * already wiped+repopulated by {@link persistParsed}, so this pass needs no
 * explicit wipe of its own. Never throws — a jOOQ problem must not fail
 * ingest.
 */
export async function extractJooqSchema(
  prisma: PrismaClient,
  codeGraphId: string,
  projectId: string,
  jooqSources: Map<string, string>,
  parsedFiles: ParsedFile[],
  stats: IngestStats,
  sourceByRelPath: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  if (jooqSources.size === 0) return;
  try {
    const tables = buildJooqTableMap(jooqSources);
    if (tables.size === 0) return;

    const candidates = parsedFiles.filter(
      (f) =>
        f.language === "java" &&
        sourceByRelPath.has(f.filePath) &&
        findJooqCallSites(sourceByRelPath.get(f.filePath) as string, tables).length > 0,
    );
    if (candidates.length === 0) return;

    const writer = new SchemaGraphWriter(
      prisma as unknown as ConstructorParameters<typeof SchemaGraphWriter>[0],
      codeGraphId,
      projectId,
    );
    // Re-queried AFTER extractOrmSchema/extractMyBatisSchema (Step 5d runs
    // after 5b/5c) so tables those passes just created this ingest are
    // already prewarmed here too — no physical table forks into two symbol
    // rows across extractors.
    const existingSchemaSymbols = await prisma.codeSymbol.findMany({
      where: { codeGraphId, kind: { in: ["table", "column"] } },
      select: { id: true, kind: true, qualifiedName: true },
    });
    writer.prewarm(existingSchemaSymbols);

    const symbolsByFile = await loadEnclosingFunctionSymbols(
      prisma,
      codeGraphId,
      candidates.map((f) => f.filePath),
    );
    for (const file of candidates) {
      try {
        stats.schemaEdges += await persistJooqCallSiteEdges(
          writer,
          file.filePath,
          sourceByRelPath.get(file.filePath) as string,
          tables,
          symbolsByFile.get(file.filePath) ?? [],
        );
      } catch {
        // Per-file jOOQ call-site failure never aborts the rest of the run.
      }
    }
  } catch {
    // Writer construction failure — degrade to no jOOQ schema edges.
  }
}

/**
 * SQLAlchemy Core & ORM query-lineage pass (#898, Epic #883) — builds a
 * framework-agnostic entity resolver from the captured `.py` sources (ORM
 * declarative classes via `__tablename__`/`Column`, Core `Table(...)` variable
 * bindings), scans the SAME `.py` files for SQLAlchemy query call sites
 * (`session.query(User)`, `select(users)`, `orders.insert()`, ...), and emits
 * `reads`/`writes` edges (`source = "orm"`) from the REAL enclosing Python
 * function symbol to the resolved physical table/column
 * (`persistSqlAlchemyCallSiteEdges`) — the Python analogue of
 * {@link extractJooqSchema}'s Java jOOQ half (#897). Raw psycopg string SQL is
 * intentionally out of scope here (it rides the sqlglot sidecar path in
 * {@link extractSchemaUsage}). A file with no resolvable call site produces NO
 * symbol or edge. All `.py` files were already wiped+repopulated by
 * {@link persistParsed}, so this pass needs no explicit wipe. Never throws — a
 * SQLAlchemy problem must not fail ingest.
 */
export async function extractSqlAlchemySchema(
  prisma: PrismaClient,
  codeGraphId: string,
  projectId: string,
  pySources: Map<string, string>,
  parsedFiles: ParsedFile[],
  stats: IngestStats,
  sourceByRelPath: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  if (pySources.size === 0) return;
  try {
    const resolver = buildSqlAlchemyEntityResolver(pySources);

    const candidates = parsedFiles.filter(
      (f) =>
        f.language === "py" &&
        sourceByRelPath.has(f.filePath) &&
        findSqlAlchemyCallSites(sourceByRelPath.get(f.filePath) as string).some(
          (s) => resolver.resolveEntity(s.entityRef) !== null,
        ),
    );
    if (candidates.length === 0) return;

    const writer = new SchemaGraphWriter(
      prisma as unknown as ConstructorParameters<typeof SchemaGraphWriter>[0],
      codeGraphId,
      projectId,
    );
    // Re-queried AFTER extractOrmSchema/extractMyBatisSchema/extractJooqSchema
    // (Step 5e runs after 5b–5d) so tables those passes just created this
    // ingest are already prewarmed here too — no physical table forks into two
    // symbol rows across extractors.
    const existingSchemaSymbols = await prisma.codeSymbol.findMany({
      where: { codeGraphId, kind: { in: ["table", "column"] } },
      select: { id: true, kind: true, qualifiedName: true },
    });
    writer.prewarm(existingSchemaSymbols);

    const symbolsByFile = await loadEnclosingFunctionSymbols(
      prisma,
      codeGraphId,
      candidates.map((f) => f.filePath),
    );
    for (const file of candidates) {
      try {
        stats.schemaEdges += await persistSqlAlchemyCallSiteEdges(
          writer,
          resolver,
          file.filePath,
          sourceByRelPath.get(file.filePath) as string,
          symbolsByFile.get(file.filePath) ?? [],
        );
      } catch {
        // Per-file SQLAlchemy call-site failure never aborts the rest of the run.
      }
    }
  } catch {
    // Writer construction failure — degrade to no SQLAlchemy schema edges.
  }
}

/**
 * Go GORM model→physical-table lineage pass (#899, Epic #883) — parses GORM
 * model structs from captured `.go` sources into the framework-agnostic
 * {@link EntityTableResolver} (via `buildGormEntityResolver`, reusing #896),
 * scans the SAME `.go` files for GORM call sites (`db.Model(&User{}).Find(...)`,
 * `db.Create(&user)`, `db.Table("users").Find(...)`) and emits `reads`/`writes`
 * edges (`source = "orm"`) from the REAL enclosing Go function symbol — the Go
 * analogue of {@link extractJooqSchema}. Runs on EVERY ingest (pure static
 * parsing, no sidecar, no live DB); Go raw-SQL strings (database/sql/sqlx) are
 * unaffected — they stay on the sqlglot embedded-SQL path (Step 6). All `.go`
 * files were already wiped+repopulated by {@link persistParsed}, so this pass
 * needs no explicit wipe of its own. Never throws — a GORM problem must not
 * fail ingest.
 */
export async function extractGoSchema(
  prisma: PrismaClient,
  codeGraphId: string,
  projectId: string,
  goSources: Map<string, string>,
  parsedFiles: ParsedFile[],
  stats: IngestStats,
  sourceByRelPath: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  if (goSources.size === 0) return;
  try {
    const resolver = buildGormEntityResolver(goSources);

    const candidates = parsedFiles.filter(
      (f) =>
        f.language === "go" &&
        sourceByRelPath.has(f.filePath) &&
        findGormCallSites(sourceByRelPath.get(f.filePath) as string, resolver).length > 0,
    );
    if (candidates.length === 0) return;

    const writer = new SchemaGraphWriter(
      prisma as unknown as ConstructorParameters<typeof SchemaGraphWriter>[0],
      codeGraphId,
      projectId,
    );
    // Re-queried AFTER the ORM/MyBatis/jOOQ passes so tables they just created
    // this ingest are already prewarmed here too — no physical table forks into
    // two symbol rows across extractors.
    const existingSchemaSymbols = await prisma.codeSymbol.findMany({
      where: { codeGraphId, kind: { in: ["table", "column"] } },
      select: { id: true, kind: true, qualifiedName: true },
    });
    writer.prewarm(existingSchemaSymbols);

    const symbolsByFile = await loadEnclosingFunctionSymbols(
      prisma,
      codeGraphId,
      candidates.map((f) => f.filePath),
    );
    for (const file of candidates) {
      try {
        stats.schemaEdges += await persistGormCallSiteEdges(
          writer,
          file.filePath,
          sourceByRelPath.get(file.filePath) as string,
          resolver,
          symbolsByFile.get(file.filePath) ?? [],
        );
      } catch {
        // Per-file GORM call-site failure never aborts the rest of the run.
      }
    }
  } catch {
    // Writer construction failure — degrade to no GORM schema edges.
  }
}

/**
 * EF Core lineage pass (#900, Epic #883) — resolves captured C# entity classes
 * to physical tables through the framework-agnostic {@link EntityTableResolver}
 * (reused from #896) and scans the SAME `.cs` files for `DbSet<T>` LINQ call
 * sites, emitting `reads`/`writes` edges from the REAL enclosing code symbol
 * (`persistEfCallSiteEdges`) — the .NET analogue of {@link extractJooqSchema}.
 * Like the jOOQ pass, a DbSet no application code queries produces NO edge:
 * tables materialize lazily where a call site resolves against them. All `.cs`
 * files were already wiped+repopulated by {@link persistParsed}, so this pass
 * needs no explicit wipe. Never throws — an EF problem must not fail ingest.
 *
 * NOTE — reachability guard (repo requirement: reachability != existence): the
 * `extractEfCoreSchema` call is wired unconditionally into `ingestCodeGraph`
 * Step 5f (NOT behind SQL_LINEAGE_MODE); `ingest-ef-wiring.test.ts` neuters the
 * body and asserts the wiring goes red, so the extractor cannot silently stop
 * running on every ingest.
 */
export async function extractEfCoreSchema(
  prisma: PrismaClient,
  codeGraphId: string,
  projectId: string,
  csSources: Map<string, string>,
  parsedFiles: ParsedFile[],
  stats: IngestStats,
): Promise<void> {
  if (csSources.size === 0) return;
  try {
    const resolver = buildEfCoreEntityResolver(csSources);
    const dbSets = buildEfDbSetTableMap(csSources, resolver);
    if (dbSets.size === 0) return;

    const candidates = parsedFiles.filter(
      (f) =>
        f.language === "cs" &&
        csSources.has(f.filePath) &&
        findEfCallSites(csSources.get(f.filePath) as string, dbSets).length > 0,
    );
    if (candidates.length === 0) return;

    const writer = new SchemaGraphWriter(
      prisma as unknown as ConstructorParameters<typeof SchemaGraphWriter>[0],
      codeGraphId,
      projectId,
    );
    // Re-queried AFTER the ORM/MyBatis/jOOQ/SQLAlchemy/GORM passes (Step 5f runs
    // after 5b–5x) so tables those passes just created this ingest are already
    // prewarmed — no physical table forks into two symbol rows across extractors.
    const existingSchemaSymbols = await prisma.codeSymbol.findMany({
      where: { codeGraphId, kind: { in: ["table", "column"] } },
      select: { id: true, kind: true, qualifiedName: true },
    });
    writer.prewarm(existingSchemaSymbols);

    const symbolsByFile = await loadEnclosingFunctionSymbols(
      prisma,
      codeGraphId,
      candidates.map((f) => f.filePath),
    );
    for (const file of candidates) {
      try {
        stats.schemaEdges += await persistEfCallSiteEdges(
          writer,
          file.filePath,
          csSources.get(file.filePath) as string,
          dbSets,
          symbolsByFile.get(file.filePath) ?? [],
        );
      } catch {
        // Per-file EF call-site failure never aborts the rest of the run.
      }
    }
  } catch {
    // Writer construction failure — degrade to no EF schema edges.
  }
}

/** Languages whose string literals ride the embedded-SQL path (#305/#888/#900). */
const EMBEDDED_SQL_LANGUAGES: ReadonlySet<string> = new Set(["ts", "js", "py", "go", "java", "cs"]);

/**
 * The persisted function/method symbols of `filePaths`, grouped by file — the
 * enclosing-code lookup every call-site pass shares (ORM, MyBatis callers,
 * jOOQ, SQLAlchemy, GORM, EF Core, embedded SQL), so a lineage edge hangs off
 * the real `UpdateFeed` method rather than a synthetic origin.
 *
 * Synthetic origins are excluded: they are `method` rows too (`language:
 * "sql"`, e.g. the MyBatis annotation statements written in Step 5c, or
 * `sql@<line>`), and being one line long they would always win the
 * narrowest-span match in {@link enclosingSymbolFor} (#760 / #807). Throws on
 * a failed query; each caller decides how to degrade.
 */
export async function loadEnclosingFunctionSymbols(
  store: Pick<PrismaClient, "codeSymbol">,
  codeGraphId: string,
  filePaths: readonly string[],
): Promise<Map<string, EnclosingSymbol[]>> {
  const byFile = new Map<string, EnclosingSymbol[]>();
  if (filePaths.length === 0) return byFile;
  const rows = await store.codeSymbol.findMany({
    where: { codeGraphId, filePath: { in: [...filePaths] }, kind: { in: ["function", "method"] } },
    select: { id: true, filePath: true, startLine: true, endLine: true, language: true },
  });
  for (const s of rows) {
    if (s.language === "sql") continue;
    const list = byFile.get(s.filePath) ?? [];
    list.push({ id: s.id, startLine: s.startLine, endLine: s.endLine });
    byFile.set(s.filePath, list);
  }
  return byFile;
}

export async function extractSchemaUsage(
  prisma: PrismaClient,
  codeGraphId: string,
  projectId: string,
  parsedFiles: ParsedFile[],
  sourceByRelPath: Map<string, string>,
  stats: IngestStats,
  wiring: SchemaUsageWiring = {},
): Promise<void> {
  // Cheap early-out: when the (per-project-resolved, #894) sidecar integration
  // is disabled, do no work at all (the extractors would each return null per
  // statement anyway). `wiring.sqlLineageOverride` is the already-resolved
  // per-project decision; undefined/null keeps the pre-#894 platform-only gate.
  if (!isSqlLineageEnabled(wiring.sqlLineageOverride)) return;

  // #317 — feed the introspected schema (SELECT* expansion / column accuracy).
  // A live-DB introspection (ground truth, passed by the caller) always wins.
  let schema = wiring.schema ?? null;

  // #901 (deferred column-level foundation) — when NO live DB schema is
  // available, reconstruct one from the INGESTED schema graph itself: the
  // `table`/`column` symbols the ORM (#849), MyBatis (#884), and DDL-file passes
  // already persisted encode the same identity sqlglot needs to resolve
  // unqualified columns to their table. This runs AFTER those passes (Step 5b/5c
  // precede Step 6), so the query sees the freshly-written schema. Best-effort:
  // any failure degrades to the prior null-schema behavior (table-level only).
  if (!schema) {
    try {
      const schemaSymbols = await prisma.codeSymbol.findMany({
        where: { codeGraphId, kind: { in: ["table", "column"] } },
        select: { kind: true, qualifiedName: true, filePath: true, source: true },
      });
      const refreshed = wiring.lineageRefreshPaths;
      schema = buildIntrospectedSchemaFromSymbols(
        refreshed && refreshed.size > 0
          ? schemaSymbols.filter((s) => !(s.source === "sqlglot" && refreshed.has(s.filePath)))
          : schemaSymbols,
      );
    } catch {
      // Symbol query failed — keep the null schema (no regression).
      schema = null;
    }
  }

  try {
    // One writer per ingest run so table/column symbols dedupe across files.
    const writer = new SchemaGraphWriter(
      prisma as unknown as ConstructorParameters<typeof SchemaGraphWriter>[0],
      codeGraphId,
      projectId,
    );
    if (wiring.lineageRefreshPaths && wiring.lineageRefreshPaths.size > 0) {
      writer.prewarm(
        await prisma.codeSymbol.findMany({
          where: { codeGraphId, kind: { in: ["table", "column"] } },
          select: { id: true, kind: true, qualifiedName: true },
        }),
      );
      // #867 — routines too, so a `catalog-deps` edge into one keeps its target.
      writer.prewarmRoutines(
        await prisma.codeSymbol.findMany({
          where: {
            codeGraphId,
            language: "sql",
            source: { not: null },
            kind: { in: ["procedure", "function"] },
          },
          select: { id: true, kind: true, qualifiedName: true },
        }),
      );
    }
    // #760 — a failed lookup degrades to synthetic `sql@<line>` origins, which
    // is a silent lineage-quality loss, so say so (#807).
    let enclosingByFile = new Map<string, EnclosingSymbol[]>();
    try {
      enclosingByFile = await loadEnclosingFunctionSymbols(
        prisma,
        codeGraphId,
        parsedFiles.filter((f) => EMBEDDED_SQL_LANGUAGES.has(f.language)).map((f) => f.filePath),
      );
    } catch (err) {
      log.warn(
        "enclosing-symbol lookup failed; embedded-SQL edges fall back to synthetic sql@<line> origins",
        { projectId, codeGraphId, error: err instanceof Error ? err.message : String(err) },
      );
    }
    for (const file of parsedFiles) {
      const source = sourceByRelPath.get(file.filePath);
      if (!source) continue;
      // Per-file isolation: one bad file must not abort the rest of the run.
      try {
        if (file.language === "sas") {
          // #306 — SAS PROC SQL only. Data steps stay with mineSasRules.
          const res = await extractSasProcSql(writer, file.filePath, source, {
            schema,
            sqlLineageOverride: wiring.sqlLineageOverride,
          });
          stats.schemaEdges += res.edges;
        } else if (EMBEDDED_SQL_LANGUAGES.has(file.language)) {
          // #305 — embedded SQL string literals across the supported languages.
          // #900 — C# ADO.NET/Dapper raw SQL rides this same extractor + gate.
          // #888 — Java raw JDBC (PreparedStatement/Statement string SQL) rides
          // the same extractor + gate; `extractRoutineUsage` below still only
          // scans ts/js/py/go internally (self-guarded), so this is a no-op
          // addition for routine-invocation detection until that's in scope.
          // #760 — edges originate from the enclosing function/method.
          const enclosingSymbols = enclosingByFile.get(file.filePath) ?? [];
          const res = await extractEmbeddedSql(writer, file.filePath, source, {
            schema,
            sqlLineageOverride: wiring.sqlLineageOverride,
            enclosingSymbols,
          });
          stats.schemaEdges += res.edges;
          // #316A — routine invocations in the same code → `executes` edges.
          const routineRes = await extractRoutineUsage(writer, file.filePath, source, {
            schema,
            sqlLineageOverride: wiring.sqlLineageOverride,
            enclosingSymbols,
          });
          stats.routineEdges += routineRes.edges;
        }
      } catch {
        // Per-file extractor failure — skip this file, keep ingesting.
      }
    }

    // #316B — parse live routine BODIES (read-only fetch) into `calls` edges. Run
    // once per ingest, after the per-file pass, so the writer's routine cache is
    // shared. Wrapped so a body-fetch/parse problem never aborts ingest.
    if (wiring.routines && wiring.routines.length > 0 && wiring.fetchRoutineBody) {
      try {
        const bodyRes = await extractRoutineBodies(
          writer,
          wiring.routines,
          wiring.fetchRoutineBody,
          {
            schema,
            dialect: wiring.routineDialect,
            sqlLineageOverride: wiring.sqlLineageOverride,
            client: wiring.client,
          },
        );
        stats.routineEdges += bodyRes.edges;
      } catch {
        // Body extraction failed wholesale — degrade to no `calls` edges.
      }
    }

    // #893 (wired by #953) — parse live PL/SQL PACKAGE BODIES into Tier-2
    // member-level `reads`/`writes`/`persists-to` edges. `extractRoutineBodies`
    // above sends the WHOLE body to sqlglot, which fails on a real package
    // member's DECLARE/BEGIN/IF/LOOP scaffolding (sqlglot upstream "not
    // planned"), leaving Oracle packages `routine-body-unanalyzed`. This pass
    // runs #892's text-only preprocessor to isolate each DML statement and
    // sends them ONE AT A TIME, attributing each to its enclosing member, plus
    // Tier-1/Tier-2 cross-validation against the SAME `wiring.dependencies`
    // rows. READ-ONLY (fetch + static parse, never executed) and gated by the
    // SAME per-project decision as everything else in this step. Runs after the
    // routine-body + per-file passes so the writer's table/routine caches are
    // shared. Wrapped so a package-body problem never aborts ingest.
    if (wiring.packages && wiring.packages.length > 0 && wiring.fetchPackageBody) {
      try {
        const pkgRes = await extractPlsqlPackageLineage(
          writer,
          wiring.packages,
          wiring.fetchPackageBody,
          wiring.dependencies ?? [],
          {
            schema,
            dialect: wiring.routineDialect,
            sqlLineageOverride: wiring.sqlLineageOverride,
            client: wiring.client,
          },
        );
        // Member-level reads/writes/persists-to + dynamic/gap `calls` edges are
        // all schema-graph edges the downstream reconciler/impact walk consume.
        stats.schemaEdges += pkgRes.edges + pkgRes.gapEdges;
      } catch {
        // Package-body extraction failed wholesale — degrade to no Tier-2 edges.
      }
    }

    // Tier-1 coarse catalog-dependency edges (#890), wired in by #894. Unlike
    // the sidecar-backed extractors above, this is zero-parse and consumes
    // rows the caller already fetched (`driver.introspectDependencies()`) — no
    // extra I/O here. Runs once per ingest, after the per-file + routine-body
    // passes, so the writer's routine/table caches are shared. Wrapped so a
    // malformed dependency row never aborts the rest of ingest.
    if (wiring.dependencies && wiring.dependencies.length > 0) {
      try {
        const depRes = await extractRoutineDependencies(writer, wiring.dependencies);
        stats.routineEdges += depRes.edges;
      } catch {
        // Dependency extraction failed wholesale — degrade to no catalog-deps edges.
      }
    }
  } catch {
    // Writer construction or an unexpected error — degrade to no sqlglot edges.
    // Ingest must never fail because the SQL-lineage path had a problem.
  }
}

/**
 * Build a mapping from every parsed file to the list of project-internal
 * file paths it imports. Pure, in-memory, used for cross-file edge
 * resolution by name.
 *
 * Resolution rules (mirrors Node-style + Python-style import semantics):
 *  - Relative imports (`./foo`, `../bar/baz`) are resolved against the
 *    importing file's directory, then matched against parsedFiles by
 *    candidate extensions (.ts/.tsx/.js/.jsx/.py/.go/.java).
 *  - `@/x` and `~/x` path aliases (#17) are tried as `<ancestor>/src/x` and
 *    `<ancestor>/x` for each ancestor directory of the importing file, nearest
 *    first — the Next.js / Vite default (`"@/*": ["./src/*"]`).
 *  - Bare imports (`react`, `lodash/fp`, `os`) are NOT resolved here —
 *    third-party packages aren't in our symbol index and chasing them
 *    would yield false positives.
 *  - Python dotted modules (`server.lib.foo`) are resolved as
 *    `server/lib/foo.py` relative to the project root (best-effort).
 *  - Java single-type imports (`org.acme.svc.OrderService`) are resolved to the
 *    parsed file ending `org/acme/svc/OrderService.java` (#17); wildcard imports
 *    are not.
 *
 * Also returns, per file, the local names imported from the runtime's standard
 * library or a test framework (#17) — evidence that a bare call to that name is
 * NOT a project symbol.
 */
export function buildFileImportIndex(
  parsedFiles: ParsedFile[],
  ctx: ImportResolutionContext,
): { importTargets: Map<string, string[]>; runtimeImports: Map<string, Set<string>> } {
  const importTargets = new Map<string, string[]>();
  const runtimeImports = new Map<string, Set<string>>();
  for (const file of parsedFiles) {
    const targets: string[] = [];
    for (const edge of file.edges) {
      if (edge.kind !== "imports") continue;
      const raw = edge.toQualifiedName;
      if (edge.importedNames?.length && isRuntimeOrTestModule(raw)) {
        let names = runtimeImports.get(file.filePath);
        if (!names) runtimeImports.set(file.filePath, (names = new Set()));
        for (const n of edge.importedNames) names.add(n);
        continue;
      }
      const resolved = resolveImportTarget(file.filePath, file.language, raw, ctx);
      if (resolved) targets.push(resolved);
    }
    if (targets.length) importTargets.set(file.filePath, targets);
  }
  return { importTargets, runtimeImports };
}

/**
 * The project files an import can resolve to. In a full ingest these are the
 * files parsed on this run; on an incremental one (#313) they are the parsed
 * files plus every unchanged file, so an import resolves identically either way.
 */
export interface ImportResolutionContext {
  filePaths: ReadonlySet<string>;
  /** `OrderService.java` → every path with that basename (Java imports). */
  javaByBasename: Map<string, string[]>;
  /** #160 — COBOL files by stem, for `COPY name`. */
  copybooks: CopybookIndex;
}

export function buildImportResolutionContext(filePaths: Iterable<string>): ImportResolutionContext {
  const paths = new Set(filePaths);
  const javaByBasename = new Map<string, string[]>();
  for (const fp of paths) {
    if (!fp.endsWith(".java")) continue;
    const base = fp.slice(fp.lastIndexOf("/") + 1);
    const list = javaByBasename.get(base);
    if (list) list.push(fp);
    else javaByBasename.set(base, [fp]);
  }
  return { filePaths: paths, javaByBasename, copybooks: buildCopybookIndex(paths) };
}

/** The project file one import specifier of `filePath` resolves to, or null. */
function resolveImportTarget(
  filePath: string,
  language: string,
  raw: string,
  ctx: ImportResolutionContext,
): string | null {
  if (language === "cbl") {
    // #160 — a copied procedure copybook's paragraphs are PERFORM targets.
    return resolveCopybook(raw, filePath, ctx.copybooks);
  }
  if (language === "java") return resolveJavaImport(raw, ctx.javaByBasename);
  const fromDir = parentDir(filePath);
  if (raw.startsWith("@/") || raw.startsWith("~/")) {
    return resolveAliasImport(fromDir, raw.slice(2), ctx.filePaths);
  }
  // Skip bare package imports — they don't resolve to in-project files.
  if (!raw.startsWith(".") && !raw.startsWith("/") && !raw.includes("/")) {
    // Python dotted module: try `a.b.c` → `a/b/c.py`.
    if (raw.includes(".") && language === "py") {
      const candidate = `${raw.replaceAll(".", "/")}.py`;
      if (ctx.filePaths.has(candidate)) return candidate;
    }
    return null;
  }
  return resolveImportPath(fromDir, raw, ctx.filePaths);
}

/** `org.acme.svc.OrderService` → the unique parsed `…/org/acme/svc/OrderService.java`. */
function resolveJavaImport(spec: string, javaByBasename: Map<string, string[]>): string | null {
  if (spec.endsWith(".*")) return null;
  const parts = spec.split(".");
  // `import static a.b.C.method` names a member; try the class one segment up too.
  for (const take of [parts.length, parts.length - 1]) {
    if (take < 1) continue;
    const suffix = `${parts.slice(0, take).join("/")}.java`;
    const base = `${parts[take - 1]}.java`;
    const hits = (javaByBasename.get(base) ?? []).filter(
      (fp) => fp === suffix || fp.endsWith(`/${suffix}`),
    );
    if (hits.length === 1) return hits[0];
  }
  return null;
}

/** `@/lib/api` from `ui/src/app/page.tsx` → `ui/src/lib/api.ts` (nearest ancestor wins). */
function resolveAliasImport(
  fromDir: string,
  rest: string,
  filePaths: ReadonlySet<string>,
): string | null {
  const segs = fromDir ? fromDir.split("/") : [];
  for (let i = segs.length; i >= 0; i -= 1) {
    const ancestor = segs.slice(0, i).join("/");
    const hit =
      resolveImportPath(ancestor, `./src/${rest}`, filePaths) ??
      resolveImportPath(ancestor, `./${rest}`, filePaths);
    if (hit) return hit;
  }
  return null;
}

function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function joinPath(a: string, b: string): string {
  const parts = (a ? a.split("/") : []).concat(b.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

const RESOLVE_EXTS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
];

function resolveImportPath(
  fromDir: string,
  spec: string,
  filePaths: ReadonlySet<string>,
): string | null {
  // Drop `.js`/`.ts` ext if present then try our candidate extensions —
  // TS source typically writes `./foo.js` referring to `foo.ts`.
  const stripped = spec.replace(/\.(?:m?[tj]sx?|c[tj]s)$/, "");
  const base = joinPath(fromDir, stripped);
  for (const ext of RESOLVE_EXTS) {
    const candidate = `${base}${ext}`;
    if (filePaths.has(candidate)) return candidate;
  }
  // Try `<base>/index.<ext>` — Node directory imports.
  for (const ext of RESOLVE_EXTS) {
    if (!ext) continue;
    const candidate = `${base}/index${ext}`;
    if (filePaths.has(candidate)) return candidate;
  }
  return null;
}

async function persistRationale(
  prisma: PrismaClient,
  projectId: string,
  parsedFiles: ParsedFile[],
  stats: IngestStats,
  triggeredByUserId: string | undefined,
  maybeYield: MaybeYield,
): Promise<void> {
  // Collect all rationale across files first so the count is accurate even
  // when persistence is skipped (no user → no Analysis row possible).
  const allFindings = parsedFiles.flatMap((f) => extractRationale(f));
  if (allFindings.length === 0) return;
  if (!triggeredByUserId) {
    // Surface the count so callers see what would have been persisted.
    stats.rationaleFindings = allFindings.length;
    return;
  }

  // One Analysis + AgentResult per ingest run. The agentKey identifies these
  // as rationale-extractor outputs so they are easy to filter in the UI.
  const analysis = await prisma.analysis.create({
    data: {
      projectId,
      startedById: triggeredByUserId,
      status: "completed",
      completedAt: new Date(),
      metadata: JSON.stringify({ source: "code-graph-ingest", filesParsed: parsedFiles.length }),
    },
    select: { id: true },
  });
  const agentResult = await prisma.agentResult.create({
    data: {
      analysisId: analysis.id,
      agentKey: "code-graph-rationale-extractor",
      status: "completed",
      completedAt: new Date(),
    },
    select: { id: true },
  });

  for (const r of allFindings) {
    await maybeYield();
    const symbolId = r.symbolQualifiedName
      ? ((
          await prisma.codeSymbol.findFirst({
            where: { projectId, qualifiedName: r.symbolQualifiedName },
            select: { id: true },
          })
        )?.id ?? null)
      : null;

    // Dedupe against existing findings keyed on the contentHash stored in evidence.
    const existing = await prisma.finding.findFirst({
      where: {
        category: r.tag,
        evidence: { contains: r.contentHash },
        agentResult: { analysis: { projectId } },
      },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.finding.create({
      data: {
        agentResultId: agentResult.id,
        category: r.tag,
        severity: "info",
        title: r.title,
        body: r.description,
        evidence: JSON.stringify({
          filePath: r.filePath,
          startLine: r.startLine,
          endLine: r.endLine,
          hintTag: r.hintTag,
          contentHash: r.contentHash,
        }),
        derivation: "extracted",
        confidence: 1.0,
        symbolId,
      },
    });
    stats.rationaleFindings += 1;
  }
}
