/**
 * Tier-2 PL/SQL package lineage orchestrator — Epic #881 Phase 3 (#893).
 *
 * Wires #892's `preprocessPlsqlBody` (which isolates individual DML statements
 * from a real Oracle package body's `DECLARE`/`BEGIN`/`IF`/`LOOP`/exception-
 * handler scaffolding) through the `metis-sql-lineage` sidecar ONE STATEMENT AT
 * A TIME, attributing each resolved table/column reference to the SPECIFIC
 * package MEMBER (procedure/function) it came from — not the package as a
 * whole. This is what lets a real member-level `reads`/`writes`/`persists-to`
 * edge exist for a package body, where `routine-body-extractor.ts` sending the
 * whole raw body to sqlglot only works for a single-statement routine (see that
 * file's PL/SQL seam doc comment).
 *
 * Two things are never dropped, mirroring the rest of the SQL-lineage path:
 *   - #892's `unresolved` facts (`EXECUTE IMMEDIATE`/unparseable `MERGE`) become
 *     a `calls` edge to a SYNTHETIC placeholder symbol (`?dynamic:<placeholder>`,
 *     #886's `dynamicPlaceholderName`/`unresolvedRefMetadata` marker shape) —
 *     `calls`, not `reads`/`writes`/`persists-to`, because #892 cannot determine
 *     read/write direction for dynamic SQL it never resolved.
 *   - A package whose body could not be fetched/preprocessed is recorded
 *     `routine-body-unanalyzed` (mirrors `extractRoutineBodies`) rather than
 *     silently treated as having no dependencies.
 *
 * Tier-1/Tier-2 cross-validation (the #893 acceptance criterion): per package,
 * every Tier-1 `catalog-deps` table (#890, zero-parse, object-level only) that
 * Tier-2 body parsing never resolved a reference to is flagged as a gap — most
 * often because it is ONLY reachable through `EXECUTE IMMEDIATE` dynamic SQL,
 * which #892 deliberately does not attempt to statically resolve. A gap is
 * persisted the same way as an unresolved dynamic reference: a `calls` edge
 * carrying `unresolvedRefMetadata()`, attributed to the package (not a specific
 * member, since Oracle's dependency catalog is object-level and does not say
 * which member made the reference).
 *
 * SECURITY / SAFETY CONTRACT (mirrors `routine-body-extractor.ts`): the package
 * body is fetched by a READ-ONLY, caller-supplied {@link PackageBodyFetcher} and
 * is ONLY PARSED (by #892's text-only pre-processor, then by the sidecar) — it
 * is NEVER executed. Feature-gated identically to the rest of the SQL-lineage
 * path: when the sidecar is disabled ({@link isSqlLineageEnabled} is false) this
 * is a complete no-op — no fetch, no sidecar call, no Tier-1 comparison. Never
 * throws on a fetch/sidecar problem for one package — that package is recorded
 * `unanalyzed`/`routine-body-unanalyzed` and the rest continue.
 */
import type { DbDependencyInfo, DbPackageInfo, SchemaEdgeKind } from "@metis/shared";
import {
  dynamicPlaceholderName,
  routineQualifiedName,
  tableQualifiedName,
  unresolvedRefMetadata,
  type SchemaGraphWriter,
} from "./schema-graph.js";
import {
  preprocessPlsqlBody,
  type PlsqlDmlStatement,
  type PlsqlUnresolvedStatement,
} from "./plsql-preprocessor.js";
import {
  extractUsageSafe,
  isSqlLineageEnabled,
  type IntrospectedSchema,
  type SqlLineageAccess,
  type SqlLineageClient,
} from "./sql-lineage-client.js";

/**
 * Reads one package's BODY source text, READ-ONLY. Returns the source (as
 * `DbPackageInfo`'s driver-level `fetchPackageBody` produces — `CREATE`-
 * prefixed), or `null` when it is unavailable (no body, wrapped/obfuscated
 * source, or the package vanished). NEVER executes the body.
 */
export type PackageBodyFetcher = (pkg: DbPackageInfo) => Promise<string | null>;

export interface PlsqlPackageLineageOptions {
  /** Dialect hint sent to the sidecar for every statement. Defaults to `"oracle"`. */
  dialect?: string;
  /** Introspected schema for SELECT* expansion / column qualification (#317). */
  schema?: IntrospectedSchema | null;
  /** Inject a client (tests); production uses the env-configured singleton. */
  client?: SqlLineageClient;
  /**
   * Epic #882 (#894) — the ALREADY-RESOLVED per-project SQL-lineage decision,
   * threaded down so this Tier-2 pass shares ONE gate with the rest of the
   * ingest SQL-lineage step (#953). `true`/`false` forces the pass on/off
   * regardless of the platform `SQL_LINEAGE_MODE`; omit to keep the platform-
   * only default.
   */
  sqlLineageOverride?: boolean | null;
}

/** One never-dropped unresolved/uncertain fact surfaced by Tier-2 parsing. */
export interface PlsqlLineageUnresolvedFact {
  /** The package's `<schema>.<name>` qualified identity. */
  package: string;
  /** The enclosing member name (`""` when undetermined). */
  member: string;
  reason: string;
  detail: string;
}

/** A table Tier-1 (`catalog-deps`) saw for a package that Tier-2 (`sqlglot`) never resolved. */
export interface PlsqlSchemaGap {
  /** The package's `<schema>.<name>` qualified identity. */
  package: string;
  /** The gap table's canonical (`tableQualifiedName`) identity. */
  table: string;
}

export interface PlsqlPackageLineageResult {
  /** Tier-2 `reads`/`writes`/`persists-to`/dynamic-`calls` edges written. */
  edges: number;
  /** Tier-1-vs-Tier-2 gap `calls` edges written. */
  gapEdges: number;
  /** Number of packages whose body was fetched and preprocessed. */
  analyzed: number;
  /** Number of packages whose body was unavailable/unfetchable. */
  unanalyzed: number;
  /** Every unresolved/uncertain fact seen — never dropped. */
  unresolved: PlsqlLineageUnresolvedFact[];
  /** Every Tier-1-only table found during cross-validation. */
  gaps: PlsqlSchemaGap[];
}

/** Maps the sidecar's per-table/column access classification to a schema edge kind. */
const ACCESS_EDGE_KIND: Record<SqlLineageAccess, SchemaEdgeKind> = {
  read: "reads",
  write: "writes",
  persist: "persists-to",
};

/** Oracle catalog object types Tier-1 cross-validation treats as routines, not tables. */
const ROUTINE_OBJECT_TYPES: ReadonlySet<string> = new Set([
  "PACKAGE",
  "PACKAGE BODY",
  "PROCEDURE",
  "FUNCTION",
]);

/** Pseudo file path for a package-body-sourced symbol/edge (no repo file — it lives in the DB). */
function packageBodyPath(pkg: DbPackageInfo): string {
  const qn = pkg.schema ? `${pkg.schema}.${pkg.name}` : pkg.name;
  return `<package-body>::${qn}`;
}

function zeroResult(): PlsqlPackageLineageResult {
  return { edges: 0, gapEdges: 0, analyzed: 0, unanalyzed: 0, unresolved: [], gaps: [] };
}

/**
 * Parse the bodies of the supplied packages via #892's DML pre-processor + the
 * sqlglot sidecar, persist per-member Tier-2 lineage edges, and cross-validate
 * against the supplied Tier-1 `catalog-deps` rows. Returns counts + never-
 * dropped unresolved facts + Tier-1-only gaps. NEVER throws.
 */
export async function extractPlsqlPackageLineage(
  writer: SchemaGraphWriter,
  packages: readonly DbPackageInfo[],
  fetchBody: PackageBodyFetcher,
  tier1Deps: readonly DbDependencyInfo[],
  opts: PlsqlPackageLineageOptions = {},
): Promise<PlsqlPackageLineageResult> {
  const result = zeroResult();
  if (!isSqlLineageEnabled(opts.sqlLineageOverride) || packages.length === 0) return result;

  const dialect = opts.dialect ?? "oracle";

  for (const pkg of packages) {
    const pkgQn = routineQualifiedName(pkg.schema || undefined, pkg.name);
    const filePath = packageBodyPath(pkg);
    // Canonical table identities Tier-2 resolved a reference to, for THIS
    // package — the cross-validation set.
    const tier2Tables = new Set<string>();

    let body: string | null = null;
    try {
      body = await fetchBody(pkg);
    } catch {
      body = null;
    }

    if (!body || !body.trim()) {
      result.unanalyzed += 1;
      result.unresolved.push({
        package: pkgQn,
        member: "",
        reason: "routine-body-unanalyzed",
        detail: "package body unavailable",
      });
    } else {
      result.analyzed += 1;
      const { statements, unresolved } = preprocessPlsqlBody(body);

      for (const stmt of statements) {
        result.edges += await persistStatement(
          writer,
          pkg,
          pkgQn,
          filePath,
          stmt,
          tier2Tables,
          result,
          dialect,
          opts,
        );
      }

      for (const u of unresolved) {
        result.unresolved.push({
          package: pkgQn,
          member: u.memberName,
          reason: u.reason,
          detail: u.placeholder,
        });
        result.edges += await persistUnresolvedMember(writer, pkg, filePath, pkgQn, u);
      }
    }

    result.gapEdges += await crossValidate(
      writer,
      pkg,
      pkgQn,
      filePath,
      tier1Deps,
      tier2Tables,
      result,
    );
  }

  return result;
}

/** Attribute one isolated DML statement's sqlglot-resolved refs to its enclosing member. */
async function persistStatement(
  writer: SchemaGraphWriter,
  pkg: DbPackageInfo,
  pkgQn: string,
  filePath: string,
  stmt: PlsqlDmlStatement,
  tier2Tables: Set<string>,
  result: PlsqlPackageLineageResult,
  dialect: string,
  opts: PlsqlPackageLineageOptions,
): Promise<number> {
  const extraction = await extractUsageSafe(
    { sql: stmt.dml, dialect, schema: opts.schema ?? null },
    opts.client,
    opts.sqlLineageOverride,
  );
  if (!extraction) {
    result.unresolved.push({
      package: pkgQn,
      member: stmt.memberName,
      reason: "routine-body-unanalyzed",
      detail: "sidecar unavailable; statement unparsed",
    });
    return 0;
  }

  let edges = 0;
  if (extraction.tables.length > 0) {
    const memberName = stmt.memberName || pkg.name;
    const fromId = await writer.ensureRoutine(memberName, "procedure", "sqlglot", {
      schema: pkg.schema || undefined,
      filePath,
    });

    const colsByTable = new Map<string, { column: string; access: SqlLineageAccess }[]>();
    for (const c of extraction.columns) {
      const list = colsByTable.get(c.table) ?? [];
      list.push({ column: c.column, access: c.access });
      colsByTable.set(c.table, list);
    }

    for (const table of extraction.tables) {
      const kind = ACCESS_EDGE_KIND[table.access];
      const tableId = await writer.ensureTable(table.name, "sqlglot", {
        schema: table.schema || undefined,
        filePath,
      });
      await writer.addEdge(fromId, kind, tableId, "sqlglot", {
        toQualifiedName: table.qualifiedName,
        filePath,
      });
      edges += 1;
      tier2Tables.add(tableQualifiedName(table.schema || undefined, table.name));

      for (const col of colsByTable.get(table.qualifiedName) ?? []) {
        const colKind = ACCESS_EDGE_KIND[col.access];
        const colId = await writer.ensureColumn(table.name, col.column, "sqlglot", {
          schema: table.schema || undefined,
          filePath,
        });
        await writer.addEdge(fromId, colKind, colId, "sqlglot", {
          toQualifiedName: `${table.qualifiedName}.${col.column}`,
          filePath,
        });
        edges += 1;
      }
    }
  }

  for (const u of extraction.uncertain) {
    result.unresolved.push({
      package: pkgQn,
      member: stmt.memberName,
      reason: u.reason,
      detail: u.detail,
    });
  }

  return edges;
}

/** Persist #892's EXECUTE IMMEDIATE / unparseable-MERGE fact as a dynamic `calls` edge. */
async function persistUnresolvedMember(
  writer: SchemaGraphWriter,
  pkg: DbPackageInfo,
  filePath: string,
  pkgQn: string,
  unresolved: PlsqlUnresolvedStatement,
): Promise<number> {
  const memberName = unresolved.memberName || pkg.name;
  const fromId = await writer.ensureRoutine(memberName, "procedure", "sqlglot", {
    schema: pkg.schema || undefined,
    filePath,
  });
  const placeholderQn = dynamicPlaceholderName(unresolved.placeholder);
  const toId = await writer.ensureTable(placeholderQn, "sqlglot", { filePath });
  const metadata = unresolvedRefMetadata({
    placeholder: unresolved.placeholder,
    statementId: `${pkgQn}#${memberName}`,
    mapper: pkgQn,
  });
  await writer.addEdge(fromId, "calls", toId, "sqlglot", {
    toQualifiedName: placeholderQn,
    filePath,
    metadata,
  });
  return 1;
}

/** Compare Tier-1 `catalog-deps` rows for one package against the Tier-2 table set just resolved. */
async function crossValidate(
  writer: SchemaGraphWriter,
  pkg: DbPackageInfo,
  pkgQn: string,
  filePath: string,
  tier1Deps: readonly DbDependencyInfo[],
  tier2Tables: ReadonlySet<string>,
  result: PlsqlPackageLineageResult,
): Promise<number> {
  const relevant = tier1Deps.filter(
    (d) =>
      d.name?.trim().toUpperCase() === pkg.name.trim().toUpperCase() &&
      !ROUTINE_OBJECT_TYPES.has((d.referencedType || "").toUpperCase()),
  );
  if (relevant.length === 0) return 0;

  let gapEdges = 0;
  // Lazily created — a package with no gap never gets a package-level symbol
  // (Tier-2 edges are attributed to members, not the package as a whole).
  let pkgFromId: string | null = null;

  for (const dep of relevant) {
    if (!dep.referencedName?.trim()) continue;
    const canonical = tableQualifiedName(dep.referencedSchema || undefined, dep.referencedName);
    if (tier2Tables.has(canonical)) continue; // resolved by Tier-2 too — not a gap

    result.gaps.push({ package: pkgQn, table: canonical });

    pkgFromId ??= await writer.ensureRoutine(pkg.name, "procedure", "sqlglot", {
      schema: pkg.schema || undefined,
      filePath,
    });
    const toId = await writer.ensureTable(dep.referencedName, "sqlglot", {
      schema: dep.referencedSchema || undefined,
      filePath,
    });
    const metadata = unresolvedRefMetadata({
      placeholder: canonical,
      statementId: `${pkgQn}#tier1-gap`,
      mapper: pkgQn,
    });
    await writer.addEdge(pkgFromId, "calls", toId, "sqlglot", {
      toQualifiedName: canonical,
      filePath,
      metadata,
    });
    gapEdges += 1;
  }

  return gapEdges;
}
