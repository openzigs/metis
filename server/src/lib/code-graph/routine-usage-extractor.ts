/**
 * Routine-usage extractor — Epic #294 (#316), part A: `executes` edges.
 *
 * Detects stored-routine INVOCATIONS embedded in ordinary application code —
 * `CALL`/`EXEC`/`EXECUTE <proc>` and user-defined `SELECT fn(...)` calls — and
 * emits `executes` edges (calling code symbol → procedure/function symbol) into
 * the schema graph with `source = "sqlglot"`.
 *
 * It reuses the SAME tree-sitter embedded-SQL scan as {@link findEmbeddedSqlCandidates}
 * (#305) to locate candidate SQL string literals, then hands each to the
 * `metis-sql-lineage` sidecar (#304), which reports routine references in its
 * `routines` field (#316 sidecar change). Built-in functions (COUNT/SUM/…) are
 * NOT reported by the sidecar, so they never produce a spurious `executes` edge.
 *
 * Why this matters: Epic #293 Phase 2 made procedures/functions first-class
 * schema objects and classifies them used/unreferenced/uncertain from inbound
 * `executes` edges — but NO `executes` edge was produced anywhere, so a routine
 * could only ever be `unreferenced`/`uncertain`. The edges emitted here flow
 * through the EXISTING reconciler/classifier (`readInboundRoutineEdges` →
 * `reconcileUsedRoutines` → `classifyObject`): a live-introspected routine with
 * an inbound `executes` edge classifies **used** with no parallel path.
 *
 * Graceful degradation (the #294 requirement): when the sidecar is disabled or
 * unreachable, {@link extractUsageSafe} returns null and this extractor emits
 * NOTHING for that file rather than throwing.
 */
import type { SchemaRoutineKind } from "@metis/shared";
import type { Language } from "./parsers.js";
import { detectLanguage } from "./parsers.js";
import { findEmbeddedSqlCandidates } from "./embedded-sql-extractor.js";
import type { SchemaGraphWriter } from "./schema-graph.js";
import {
  extractUsageSafe,
  type IntrospectedSchema,
  type SqlLineageClient,
} from "./sql-lineage-client.js";

/** Languages whose embedded SQL we scan for routine invocations (mirrors #305). */
const SUPPORTED_LANGUAGES: ReadonlySet<Language> = new Set<Language>(["ts", "js", "py", "go"]);

/**
 * The routine kind recorded for a code-detected invocation. A call site does not
 * tell us whether the callee is a procedure or a function, so we default to
 * `procedure`; reconciliation against the live introspection (which knows the
 * real kind) resolves the routine by qualified name regardless. The
 * {@link reconcileUsedRoutines} keys on `<kind> <qualified-name>`, so a code
 * `executes` edge whose target routine symbol matches a live routine by name
 * lights it up `used`.
 */
const DEFAULT_ROUTINE_KIND: SchemaRoutineKind = "procedure";

export interface RoutineUsageOptions {
  /** Override the dialect hint (e.g. from a known DB connector on the project). */
  dialect?: string;
  /** Introspected schema for SELECT* expansion / column qualification (#317). */
  schema?: IntrospectedSchema | null;
  /** Inject a client (tests); production uses the env-configured singleton. */
  client?: SqlLineageClient;
  /** Epic #882 (#894) — resolved per-project SQL-lineage override. */
  sqlLineageOverride?: boolean | null;
}

export interface RoutineUsageResult {
  /** Number of `executes` edges written. */
  edges: number;
  /** Number of SQL candidates located. */
  candidates: number;
  /** Number of distinct routines referenced. */
  routines: number;
}

/** Build the `from` (calling code) symbol id for a routine invocation site. */
async function originFor(
  writer: SchemaGraphWriter,
  filePath: string,
  line: number,
): Promise<string> {
  return writer.createOriginSymbol(
    "method",
    `exec@${line}`,
    `${filePath}::exec@${line}`,
    filePath,
    line,
  );
}

/**
 * Extract routine invocations from one source file and persist `executes` edges
 * (code symbol → routine), `source = "sqlglot"`. Returns counts. Never throws on
 * sidecar problems (graceful degradation); returns a zeroed result when the
 * language is unsupported or no SQL is found, without contacting the sidecar.
 */
export async function extractRoutineUsage(
  writer: SchemaGraphWriter,
  filePath: string,
  source: string,
  opts: RoutineUsageOptions = {},
): Promise<RoutineUsageResult> {
  const empty: RoutineUsageResult = { edges: 0, candidates: 0, routines: 0 };
  const language = detectLanguage(filePath);
  if (!language || !SUPPORTED_LANGUAGES.has(language)) return empty;

  const candidates = findEmbeddedSqlCandidates(source, language);
  if (candidates.length === 0) return empty;

  const dialect = opts.dialect ?? "";
  const result: RoutineUsageResult = { ...empty, candidates: candidates.length };
  // Dedupe (origin-line, routine-qn) so the same call written once doesn't double.
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const extraction = await extractUsageSafe(
      { sql: candidate.sql, dialect, schema: opts.schema ?? null },
      opts.client,
      opts.sqlLineageOverride,
    );
    if (!extraction || extraction.routines.length === 0) continue;

    const fromId = await originFor(writer, filePath, candidate.line);
    for (const routine of extraction.routines) {
      const dedupeKey = `${candidate.line}::${routine.qualifiedName}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const routineId = await writer.ensureRoutine(routine.name, DEFAULT_ROUTINE_KIND, "sqlglot", {
        schema: routine.schema || undefined,
        filePath,
        line: candidate.line,
      });
      await writer.addEdge(fromId, "executes", routineId, "sqlglot", {
        toQualifiedName: routine.qualifiedName,
        filePath,
        line: candidate.line,
      });
      result.edges += 1;
      result.routines += 1;
    }
  }

  return result;
}
