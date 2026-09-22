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
import type { Prisma, PrismaClient } from "@prisma/client";
import { compileMetisignore, DEFAULT_METISIGNORE, isIgnored } from "./metisignore.js";
import { detectLanguage, initCodeGraphParsers, parseSource, type ParsedFile } from "./parsers.js";
import {
  createResolutionIndex,
  indexSymbol,
  isRuntimeOrTestModule,
  resolveEdgeTarget,
  type ResolvableSymbol,
} from "./call-resolution.js";
import { createEventLoopYielder, type MaybeYield } from "./event-loop-yield.js";
import type { DbDependencyInfo, DbPackageInfo, DbRoutineInfo } from "@metis/shared";
import { extractRoutineDependencies } from "./routine-dependency-extractor.js";
import { extractPlsqlPackageLineage, type PackageBodyFetcher } from "./plsql-package-lineage.js";
import { extractRationale } from "./rationale-extractor.js";
import { extractEmbeddedSql } from "./embedded-sql-extractor.js";
import { extractSasProcSql } from "./sas-rule-miner.js";
import { extractRoutineUsage } from "./routine-usage-extractor.js";
import { extractRoutineBodies, type RoutineBodyFetcher } from "./routine-body-extractor.js";
import { SchemaGraphWriter } from "./schema-graph.js";
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
  type IntrospectedSchema,
  type SqlLineageClient,
} from "./sql-lineage-client.js";
import {
  computeSymbolHash,
  formatSymbolForEmbedding,
  type SymbolKind as EmbeddingSymbolKind,
} from "./symbol-embeddings.js";
import { enqueueSymbolEmbeddings } from "./symbol-embedding-service.js";
import { reconcileProjectSchemaIdentities } from "../cross-project/schema-object-identity-service.js";

export interface IngestOptions {
  projectId: string;
  rootDir: string;
  /** Optional connector-id used for the CodeGraph FK. */
  repoConnectionId?: string;
  /** Optional commit SHA to record on the CodeGraph row. */
  commitSha?: string;
  /**
   * When true, skip files whose recorded `contentHash` matches the on-disk
   * SHA256. Defaults to true. Set false to force a full re-ingest.
   */
  incremental?: boolean;
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
  const graph = await upsertCodeGraph(prisma, projectId, repoConnectionId, commitSha);

  // Step 2 — load .metisignore (file or default).
  const metisignorePath = path.join(rootDir, ".metisignore");
  let ignoreContent = DEFAULT_METISIGNORE;
  try {
    ignoreContent = await fs.readFile(metisignorePath, "utf8");
  } catch {
    // File missing — use defaults. NOT a hard error.
  }
  const ignoreRules = compileMetisignore(ignoreContent);

  // Step 3 — load existing per-file hashes for incremental skip.
  const existingHashes = incremental
    ? await loadExistingFileHashes(prisma, graph.id)
    : new Map<string, string>();

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
  // #900 — C#/.NET source files (`.cs`) mapped to their source for the EF Core
  // lineage pass. Captured after parsing (mirroring the JPA/jOOQ `.java`
  // capture below); `extractEfCoreSchema` itself gates on the presence of a
  // resolvable `DbSet<T>`, so an unrelated `.cs` file yields zero edges.
  const csSources = new Map<string, string>();
  for await (const filePath of walkTree(rootDir, ignoreRules)) {
    stats.filesScanned += 1;
    const lang = detectLanguage(filePath);
    if (!lang) {
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
    let source: string;
    try {
      source = stripNulBytes(await fs.readFile(filePath, "utf8"));
    } catch {
      stats.filesSkipped += 1;
      continue;
    }
    const fileHash = sha256(source);
    const relPath = path.relative(rootDir, filePath).split(path.sep).join("/");
    if (incremental && existingHashes.get(relPath) === fileHash) {
      stats.filesSkipped += 1;
      continue;
    }
    await maybeYield();
    const parsed = parseSource(relPath, source, lang);
    if (parsed.unparseable) {
      stats.filesSkipped += 1;
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
  await persistParsed(prisma, graph.id, projectId, parsedFiles, stats, sourceByRelPath, maybeYield);

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
  await extractSchemaUsage(prisma, graph.id, projectId, parsedFiles, sourceByRelPath, stats, {
    schema: options.introspectedSchema ?? null,
    routines: options.routines,
    fetchRoutineBody: options.fetchRoutineBody,
    routineDialect: options.routineDialect,
    packages: options.packages,
    fetchPackageBody: options.fetchPackageBody,
    dependencies: options.dependencies,
    sqlLineageOverride: options.sqlLineageOverride,
  });

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

  // Step 8 — finalise CodeGraph counts.
  const totalSymbols = await prisma.codeSymbol.count({ where: { codeGraphId: graph.id } });
  const totalEdges = await prisma.codeEdge.count({ where: { codeGraphId: graph.id } });
  const langGrouping = await prisma.codeSymbol.groupBy({
    by: ["language"],
    where: { codeGraphId: graph.id },
    _count: { _all: true },
  });
  const langStatsRecord: Record<string, number> = {};
  for (const row of langGrouping) {
    langStatsRecord[row.language] = row._count._all;
  }
  await prisma.codeGraph.update({
    where: { id: graph.id },
    data: {
      symbolCount: totalSymbols,
      edgeCount: totalEdges,
      languageStats: JSON.stringify(langStatsRecord),
      lastIndexedAt: new Date(),
    },
  });

  // Step 9 — Epic #780 / Issue #797. Symbols (and their index-time text) are
  // durable now; hand the embedding off to a background job. Fire-and-forget:
  // it must never fail or delay the ingest that produced them.
  if (options.embedSymbols) {
    enqueueSymbolEmbeddings(projectId);
  }

  stats.durationMs = Date.now() - start;
  return stats;
}

/**
 * Async generator that yields absolute paths for every file under `rootDir`
 * that survives the ignore rules. Directories are filtered before recursion
 * so `node_modules` etc. never get walked into.
 */
async function* walkTree(
  rootDir: string,
  rules: ReturnType<typeof compileMetisignore>,
  current: string = rootDir,
): AsyncGenerator<string> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(current, entry.name);
    const rel = path.relative(rootDir, abs).split(path.sep).join("/");
    if (isIgnored(rules, rel, entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      yield* walkTree(rootDir, rules, abs);
    } else if (entry.isFile()) {
      yield abs;
    }
  }
}

async function upsertCodeGraph(
  prisma: PrismaClient,
  projectId: string,
  repoConnectionId: string | undefined,
  commitSha: string | undefined,
): Promise<{ id: string }> {
  const existing = await prisma.codeGraph.findFirst({
    where: { projectId, repoConnectionId: repoConnectionId ?? null },
  });
  if (existing) {
    if (commitSha && existing.commitSha !== commitSha) {
      await prisma.codeGraph.update({ where: { id: existing.id }, data: { commitSha } });
    }
    return existing;
  }
  return prisma.codeGraph.create({
    data: {
      projectId,
      repoConnectionId: repoConnectionId ?? null,
      commitSha: commitSha ?? null,
    },
    select: { id: true },
  }) as Promise<{ id: string }>;
}

async function loadExistingFileHashes(
  prisma: PrismaClient,
  codeGraphId: string,
): Promise<Map<string, string>> {
  // Module symbols carry the file-level hash in `contentHash` (parsers
  // populate it from the full source). Use them as the file-hash index.
  const rows = await prisma.codeSymbol.findMany({
    where: { codeGraphId, kind: "module" },
    select: { filePath: true, contentHash: true },
  });
  const out = new Map<string, string>();
  for (const r of rows) out.set(r.filePath, r.contentHash);
  return out;
}

async function persistParsed(
  prisma: PrismaClient,
  codeGraphId: string,
  projectId: string,
  parsedFiles: ParsedFile[],
  stats: IngestStats,
  sourceByRelPath: Map<string, string>,
  maybeYield: MaybeYield,
): Promise<void> {
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
  const fileToSymbols = new Map<string, ResolvableSymbol[]>();
  const index = createResolutionIndex();

  for (const file of parsedFiles) {
    await maybeYield();
    // Wipe previous symbols+edges for this file so we don't accumulate stale rows,
    // and insert its symbols — one batch transaction per FILE (#16). On SQLite a
    // statement outside a transaction is its own commit, and each commit is a
    // synchronous journal write + fsync on the event-loop thread; per-row commits
    // made the persist phase ~420k of them for this repository.
    const results = await prisma.$transaction([
      prisma.codeEdge.deleteMany({ where: { codeGraphId, filePath: file.filePath } }),
      prisma.codeSymbol.deleteMany({ where: { codeGraphId, filePath: file.filePath } }),
      ...file.symbols.map((sym) =>
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
          },
          select: { id: true },
        }),
      ),
    ]);
    const createdIds = (results.slice(2) as Array<{ id: string }>).map((r) => r.id);

    // Issue #797 — the index-time embedding TEXT is formatted HERE, while the
    // source file is still in memory. It cannot be rebuilt later: `CodeSymbol`
    // persists no signature, docstring or body, so a background embed job or an
    // #787 model-flip reindex has nothing to format from. Hence
    // `CodeSymbolEmbedding.text`.
    const sourceLines = (sourceByRelPath.get(file.filePath) ?? "").split("\n");
    const embeddingRows: Array<{
      codeGraphId: string;
      projectId: string;
      symbolId: string;
      text: string;
      contentHash: string;
    }> = [];

    const fileSyms: ResolvableSymbol[] = [];
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
      fileSyms.push(idx);
      // First definition of a name within a file wins (deterministic).
      indexSymbol(index, idx);
      qnameToId.set(sym.qualifiedName, id);
      stats.symbolsUpserted += 1;

      const text = formatSymbolForEmbedding({
        symbolId: id,
        name: sym.name,
        qualifiedName: sym.qualifiedName,
        kind: sym.kind as EmbeddingSymbolKind,
        filePath: file.filePath,
        bodyLines: sourceLines.slice(sym.startLine - 1, sym.endLine),
      });
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
    fileToSymbols.set(file.filePath, fileSyms);
  }

  // ── Pass 2: build import-target index and persist edges. ────────────────
  const { importTargets, runtimeImports } = buildFileImportIndex(parsedFiles, fileToSymbols);

  for (const file of parsedFiles) {
    const site = {
      filePath: file.filePath,
      language: file.language,
      importedFiles: importTargets.get(file.filePath) ?? [],
      runtimeImports: runtimeImports.get(file.filePath),
    };

    // Edges carry no ids anyone needs back, so they go in multi-row inserts:
    // one statement (and one commit) per EDGE_INSERT_BATCH rows (#16).
    let batch: Prisma.CodeEdgeCreateManyInput[] = [];
    for (const edge of file.edges) {
      await maybeYield();
      const fromId = qnameToId.get(edge.fromQualifiedName);
      if (!fromId) continue; // Dropped: no source symbol — should not happen.

      let toId: string | null = qnameToId.get(edge.toQualifiedName) ?? null;
      if (!toId) {
        toId = resolveEdgeTarget(edge.toQualifiedName, edge.receiver, site, index);
      }

      batch.push({
        codeGraphId,
        projectId,
        kind: edge.kind,
        fromSymbolId: fromId,
        toSymbolId: toId,
        toQualifiedName: edge.toQualifiedName,
        filePath: file.filePath,
        line: edge.line,
        metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      });
      if (batch.length >= EDGE_INSERT_BATCH) {
        await prisma.codeEdge.createMany({ data: batch });
        stats.edgesUpserted += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await prisma.codeEdge.createMany({ data: batch });
      stats.edgesUpserted += batch.length;
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
        const symbolRows = await prisma.codeSymbol.findMany({
          where: {
            codeGraphId,
            filePath: { in: candidates.map((f) => f.filePath) },
            kind: { in: ["function", "method"] },
          },
          select: { id: true, filePath: true, startLine: true, endLine: true },
        });
        const symbolsByFile = new Map<string, EnclosingSymbol[]>();
        for (const s of symbolRows) {
          const list = symbolsByFile.get(s.filePath) ?? [];
          list.push({ id: s.id, startLine: s.startLine, endLine: s.endLine });
          symbolsByFile.set(s.filePath, list);
        }
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
          const callerSymbolRows = await prisma.codeSymbol.findMany({
            where: {
              codeGraphId,
              filePath: { in: candidates.map((f) => f.filePath) },
              kind: { in: ["function", "method"] },
            },
            select: { id: true, filePath: true, startLine: true, endLine: true },
          });
          const callerSymbolsByFile = new Map<string, EnclosingSymbol[]>();
          for (const s of callerSymbolRows) {
            const list = callerSymbolsByFile.get(s.filePath) ?? [];
            list.push({ id: s.id, startLine: s.startLine, endLine: s.endLine });
            callerSymbolsByFile.set(s.filePath, list);
          }
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

    const symbolRows = await prisma.codeSymbol.findMany({
      where: {
        codeGraphId,
        filePath: { in: candidates.map((f) => f.filePath) },
        kind: { in: ["function", "method"] },
      },
      select: { id: true, filePath: true, startLine: true, endLine: true },
    });
    const symbolsByFile = new Map<string, EnclosingSymbol[]>();
    for (const s of symbolRows) {
      const list = symbolsByFile.get(s.filePath) ?? [];
      list.push({ id: s.id, startLine: s.startLine, endLine: s.endLine });
      symbolsByFile.set(s.filePath, list);
    }
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

    const symbolRows = await prisma.codeSymbol.findMany({
      where: {
        codeGraphId,
        filePath: { in: candidates.map((f) => f.filePath) },
        kind: { in: ["function", "method"] },
      },
      select: { id: true, filePath: true, startLine: true, endLine: true },
    });
    const symbolsByFile = new Map<string, EnclosingSymbol[]>();
    for (const s of symbolRows) {
      const list = symbolsByFile.get(s.filePath) ?? [];
      list.push({ id: s.id, startLine: s.startLine, endLine: s.endLine });
      symbolsByFile.set(s.filePath, list);
    }
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

    const symbolRows = await prisma.codeSymbol.findMany({
      where: {
        codeGraphId,
        filePath: { in: candidates.map((f) => f.filePath) },
        kind: { in: ["function", "method"] },
      },
      select: { id: true, filePath: true, startLine: true, endLine: true },
    });
    const symbolsByFile = new Map<string, EnclosingSymbol[]>();
    for (const s of symbolRows) {
      const list = symbolsByFile.get(s.filePath) ?? [];
      list.push({ id: s.id, startLine: s.startLine, endLine: s.endLine });
      symbolsByFile.set(s.filePath, list);
    }
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

    const symbolRows = await prisma.codeSymbol.findMany({
      where: {
        codeGraphId,
        filePath: { in: candidates.map((f) => f.filePath) },
        kind: { in: ["function", "method"] },
      },
      select: { id: true, filePath: true, startLine: true, endLine: true },
    });
    const symbolsByFile = new Map<string, EnclosingSymbol[]>();
    for (const s of symbolRows) {
      const list = symbolsByFile.get(s.filePath) ?? [];
      list.push({ id: s.id, startLine: s.startLine, endLine: s.endLine });
      symbolsByFile.set(s.filePath, list);
    }
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
        select: { kind: true, qualifiedName: true },
      });
      schema = buildIntrospectedSchemaFromSymbols(schemaSymbols);
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
        } else if (
          file.language === "ts" ||
          file.language === "js" ||
          file.language === "py" ||
          file.language === "go" ||
          file.language === "java" ||
          file.language === "cs"
        ) {
          // #305 — embedded SQL string literals across the supported languages.
          // #900 — C# ADO.NET/Dapper raw SQL rides this same extractor + gate.
          // #888 — Java raw JDBC (PreparedStatement/Statement string SQL) rides
          // the same extractor + gate; `extractRoutineUsage` below still only
          // scans ts/js/py/go internally (self-guarded), so this is a no-op
          // addition for routine-invocation detection until that's in scope.
          const res = await extractEmbeddedSql(writer, file.filePath, source, {
            schema,
            sqlLineageOverride: wiring.sqlLineageOverride,
          });
          stats.schemaEdges += res.edges;
          // #316A — routine invocations in the same code → `executes` edges.
          const routineRes = await extractRoutineUsage(writer, file.filePath, source, {
            schema,
            sqlLineageOverride: wiring.sqlLineageOverride,
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
function buildFileImportIndex(
  parsedFiles: ParsedFile[],
  fileToSymbols: Map<string, unknown[]>,
): { importTargets: Map<string, string[]>; runtimeImports: Map<string, Set<string>> } {
  const filePaths = new Set<string>(parsedFiles.map((f) => f.filePath));
  // `OrderService.java` → every parsed path with that basename (Java imports).
  const javaByBasename = new Map<string, string[]>();
  for (const fp of filePaths) {
    if (!fp.endsWith(".java")) continue;
    const base = fp.slice(fp.lastIndexOf("/") + 1);
    const list = javaByBasename.get(base);
    if (list) list.push(fp);
    else javaByBasename.set(base, [fp]);
  }
  const importTargets = new Map<string, string[]>();
  const runtimeImports = new Map<string, Set<string>>();
  for (const file of parsedFiles) {
    const targets: string[] = [];
    const fromDir = parentDir(file.filePath);
    for (const edge of file.edges) {
      if (edge.kind !== "imports") continue;
      const raw = edge.toQualifiedName;
      if (edge.importedNames?.length && isRuntimeOrTestModule(raw)) {
        let names = runtimeImports.get(file.filePath);
        if (!names) runtimeImports.set(file.filePath, (names = new Set()));
        for (const n of edge.importedNames) names.add(n);
        continue;
      }
      if (file.language === "java") {
        const resolved = resolveJavaImport(raw, javaByBasename);
        if (resolved && fileToSymbols.has(resolved)) targets.push(resolved);
        continue;
      }
      if (raw.startsWith("@/") || raw.startsWith("~/")) {
        const resolved = resolveAliasImport(fromDir, raw.slice(2), filePaths);
        if (resolved && fileToSymbols.has(resolved)) targets.push(resolved);
        continue;
      }
      // Skip bare package imports — they don't resolve to in-project files.
      if (!raw.startsWith(".") && !raw.startsWith("/") && !raw.includes("/")) {
        // Python dotted module: try `a.b.c` → `a/b/c.py`.
        if (raw.includes(".") && file.language === "py") {
          const candidate = `${raw.replaceAll(".", "/")}.py`;
          if (filePaths.has(candidate)) targets.push(candidate);
        }
        continue;
      }
      const resolved = resolveImportPath(fromDir, raw, filePaths);
      if (resolved && fileToSymbols.has(resolved)) targets.push(resolved);
    }
    if (targets.length) importTargets.set(file.filePath, targets);
  }
  return { importTargets, runtimeImports };
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
function resolveAliasImport(fromDir: string, rest: string, filePaths: Set<string>): string | null {
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

function resolveImportPath(fromDir: string, spec: string, filePaths: Set<string>): string | null {
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
