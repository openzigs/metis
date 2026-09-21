/**
 * Tier-1 routine-dependency extractor — Epic #881 Phase 1 (#890).
 *
 * Turns coarse {@link DbDependencyInfo} rows (read from a dialect's dependency
 * catalog — Oracle `ALL_DEPENDENCIES`/`DBA_DEPENDENCIES`, see
 * `OracleDriverAdapter.introspectDependencies`) into `calls` edges
 * (PL/SQL object → the table/object it references) in the schema graph,
 * `source = "catalog-deps"`.
 *
 * This is the ZERO-PARSE counterpart to the Tier-2 body-parsed `calls` edges
 * emitted by {@link extractRoutineBodies} (`source = "sqlglot"`): it never reads
 * or parses a routine's source, so it works even when Tier-2 body parsing
 * (#891-#893) is unavailable or the SQL-lineage sidecar is disabled — the
 * catalog rows are simply handed in by the caller. NO PL/SQL is ever executed
 * (the dependency rows themselves are the only input; this module makes no
 * database calls).
 *
 * Coarse marker (the #890 acceptance criterion): every edge this module writes
 * carries an explicit `{ tier: 1, coarse: true, direction: "unknown" }` marker
 * in `CodeEdge.metadata` (JSON-encoded by {@link SchemaGraphWriter.addEdge}) —
 * "coarse" because Oracle's dependency catalog is object-level only (no column
 * granularity) and "direction: unknown" because the catalog does not say
 * whether the reference is a read, a write, or both. Tier-2 body parsing
 * (`source = "sqlglot"`) additionally outranks `catalog-deps` in
 * `SCHEMA_SOURCE_PRECEDENCE`, so a future reconciliation pass can refine or
 * override a coarse edge once precise per-statement access is known.
 */
import type { DbDependencyInfo, SchemaRoutineKind } from "@metis/shared";
import {
  routineQualifiedName,
  tableQualifiedName,
  type SchemaGraphWriter,
} from "./schema-graph.js";

/** Pseudo file path for a Tier-1 catalog-sourced edge (no repo file — it lives in the DB catalog). */
const CATALOG_DEPENDENCY_FILE = "<oracle-all-dependencies>";

/** Explicit Tier-1 coarse-lineage marker persisted on every edge this module writes (#890). */
export const TIER1_COARSE_METADATA: Readonly<{
  tier: 1;
  coarse: true;
  direction: "unknown";
}> = { tier: 1, coarse: true, direction: "unknown" };

/** Oracle catalog object types this Tier treats as routines rather than plain tables/views. */
const ROUTINE_OBJECT_TYPES: ReadonlySet<string> = new Set([
  "PACKAGE",
  "PACKAGE BODY",
  "PROCEDURE",
  "FUNCTION",
]);

/** Map a catalog object `TYPE` string to a {@link SchemaRoutineKind}, defaulting to `procedure`. */
function toRoutineKind(type: string): SchemaRoutineKind {
  return type.toUpperCase() === "FUNCTION" ? "function" : "procedure";
}

export interface RoutineDependencyResult {
  /** Number of coarse `calls` edges written. */
  edges: number;
  /** Number of distinct referencing routines seen. */
  routines: number;
}

/**
 * Persist coarse `calls` edges (PL/SQL object → referenced table/object) for
 * every dependency row supplied. Pure orchestration over the injected
 * {@link SchemaGraphWriter} — makes no database calls of its own. Skips rows
 * missing an identity (empty name/referenced name) rather than throwing, so
 * one malformed catalog row never aborts the rest.
 */
export async function extractRoutineDependencies(
  writer: SchemaGraphWriter,
  dependencies: readonly DbDependencyInfo[],
): Promise<RoutineDependencyResult> {
  const result: RoutineDependencyResult = { edges: 0, routines: 0 };
  if (dependencies.length === 0) return result;

  const seenRoutines = new Set<string>();

  for (const dep of dependencies) {
    if (!dep.name?.trim() || !dep.referencedName?.trim()) continue;

    const fromKind = toRoutineKind(dep.type);
    const fromId = await writer.ensureRoutine(dep.name, fromKind, "catalog-deps", {
      schema: dep.schema || undefined,
      filePath: CATALOG_DEPENDENCY_FILE,
    });

    const routineKey = `${fromKind}:${routineQualifiedName(dep.schema || undefined, dep.name)}`;
    if (!seenRoutines.has(routineKey)) {
      seenRoutines.add(routineKey);
      result.routines += 1;
    }

    // The referenced object may itself be a routine (a package calling another
    // package/procedure/function) — ensure it lands on a routine symbol rather
    // than a bogus table so the reconciler/classifier see it correctly. Any
    // other catalog type (TABLE/VIEW/SEQUENCE/SYNONYM/…) folds into the
    // schema graph's general `table` kind, the only relational-object bucket it
    // has today.
    let toId: string;
    let toQualifiedName: string;
    if (ROUTINE_OBJECT_TYPES.has(dep.referencedType.toUpperCase())) {
      const toKind = toRoutineKind(dep.referencedType);
      toId = await writer.ensureRoutine(dep.referencedName, toKind, "catalog-deps", {
        schema: dep.referencedSchema || undefined,
        filePath: CATALOG_DEPENDENCY_FILE,
      });
      toQualifiedName = routineQualifiedName(dep.referencedSchema || undefined, dep.referencedName);
    } else {
      toId = await writer.ensureTable(dep.referencedName, "catalog-deps", {
        schema: dep.referencedSchema || undefined,
        filePath: CATALOG_DEPENDENCY_FILE,
      });
      toQualifiedName = tableQualifiedName(dep.referencedSchema || undefined, dep.referencedName);
    }

    // `calls` = routine → object, mirroring the Tier-2 edge kind (#301); the
    // `source`/`metadata` pair is what distinguishes this coarse Tier-1 edge.
    await writer.addEdge(fromId, "calls", toId, "catalog-deps", {
      toQualifiedName,
      filePath: CATALOG_DEPENDENCY_FILE,
      metadata: TIER1_COARSE_METADATA,
    });
    result.edges += 1;
  }

  return result;
}
