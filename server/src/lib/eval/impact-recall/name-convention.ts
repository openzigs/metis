/**
 * Issue #1016 (epic #999) — the corpus qualified-name CONVENTION self-check.
 *
 * WHY THIS EXISTS. An eval corpus whose symbol names are shaped differently from
 * what ingest actually emits does not merely under-test: it produces confident,
 * WRONG numbers. In #1002 the corpus used dotted `org.jpetstore.domain.Account`
 * names while production ingest emits `path/to/File.java::Type::member`. The
 * divergence silently corrupted `buildEntityVocabulary` on real projects — it
 * produced vocabulary entries such as `"ts"`, `"java"` and raw path prefixes,
 * which then GROUNDED SUCCESSFULLY and ran semantically meaningless BM25 queries.
 * Neither the unit tests nor the harness could see it, because both used the
 * corpus convention. This is the inverse of fabrication and much harder to catch:
 * nothing fails, the numbers just describe a different world.
 *
 * WHAT MAKES IT DURABLE. The expectation is DERIVED FROM THE EMITTERS, not
 * restated here:
 *
 *   - code symbols   → `code-graph/qualified-name.ts`, the module the parsers
 *                      (`parsers.ts`, `parsers-tree-sitter.ts`) now build every
 *                      qualified name with.
 *   - tables/columns → `code-graph/schema-graph.ts`'s own `tableQualifiedName` /
 *                      `columnQualifiedName`, i.e. the schema-graph writer.
 *
 * So if a parser changes its separator or the schema writer changes its shape, the
 * expectation MOVES WITH IT and the corpus fails loudly — there is no second copy
 * of the convention to drift apart from the first.
 *
 * Pure and dependency-free (no fs, no DB), so the CLI, the unit tests and any
 * future corpus author run exactly the same check.
 */
import {
  CODE_QUALIFIED_NAME_SEPARATOR,
  isCodeQualifiedNameOf,
  moduleQualifiedName,
} from "../../code-graph/qualified-name.js";
import { columnQualifiedName, tableQualifiedName } from "../../code-graph/schema-graph.js";
import type { FixtureCodeSymbol, FixtureTable, ImpactRecallManifest } from "./fixture.js";

/** One corpus row that does not match what ingest emits. */
export interface NameConventionViolation {
  /** `codeSymbols` or `tables` row id. */
  id: string;
  qualifiedName: string;
  /** Human-readable reason, naming the emitter the expectation came from. */
  reason: string;
}

export interface NameConventionReport {
  violations: NameConventionViolation[];
  /** Rows examined (code symbols + tables). */
  checkedCount: number;
  /**
   * Rows carrying the production `::` code shape. A corpus with ZERO of these is
   * itself a violation: it cannot exercise convention-sensitive code at all, which
   * is exactly the state that hid the #1002 defect.
   */
  productionShapedCount: number;
}

/**
 * `language` the schema-graph writer stamps on every row it creates — SQL
 * routines, columns, tables and the synthesized MyBatis origin symbols. Those
 * names are NAMESPACES (`<mapper-namespace>.<statementId>`), not file-rooted code
 * names, so they are held to the schema convention instead.
 */
const SQL_LANGUAGE = "sql";

/**
 * Symbol kinds `code-graph/parsers.ts` can emit (its `SymbolKind` union) plus the
 * schema-graph writer's kinds. A corpus row of any other kind models something no
 * ingest path produces — `kind: "file"` (corpus-01 before #1016) is the concrete
 * example: `buildEntityVocabulary`'s `FILE_KINDS` happens to list it, so the
 * mismatch was invisible, but production only ever emits `module`.
 */
const INGEST_SYMBOL_KINDS: ReadonlySet<string> = new Set([
  // parsers.ts SymbolKind
  "function",
  "class",
  "interface",
  "type",
  "module",
  "method",
  // schema-graph.ts writer kinds
  "table",
  "column",
  "procedure",
]);

/** Check ONE code-symbol row against the emitters' convention. */
function checkCodeSymbol(symbol: FixtureCodeSymbol): NameConventionViolation[] {
  const out: NameConventionViolation[] = [];
  const { id, qualifiedName, filePath, kind, language } = symbol;

  if (!INGEST_SYMBOL_KINDS.has(kind)) {
    out.push({
      id,
      qualifiedName,
      reason:
        `kind ${JSON.stringify(kind)} is not emitted by any ingest path ` +
        `(parsers.ts SymbolKind + schema-graph.ts writer kinds)`,
    });
  }

  if (language === SQL_LANGUAGE) {
    // The schema-graph writer's `createOriginSymbol` persists a MyBatis statement
    // under its DOTTED mapper namespace. It is never file-rooted, so the code
    // separator must not appear.
    if (qualifiedName.includes(CODE_QUALIFIED_NAME_SEPARATOR)) {
      out.push({
        id,
        qualifiedName,
        reason:
          `SQL-language row uses the code separator ${JSON.stringify(CODE_QUALIFIED_NAME_SEPARATOR)}; ` +
          "schema-graph.ts emits a dotted mapper namespace for origin symbols",
      });
    }
    return out;
  }

  if (kind === "module") {
    // parsers.ts: `const moduleQname = moduleQualifiedName(filePath)`.
    if (qualifiedName !== moduleQualifiedName(filePath)) {
      out.push({
        id,
        qualifiedName,
        reason: `module row must equal its filePath (${JSON.stringify(filePath)}) — parsers.ts moduleQualifiedName`,
      });
    }
    return out;
  }

  // parsers.ts: every declaration is `buildCodeQualifiedName(moduleQname, …)`, so
  // it is rooted at the file path and separated by the code separator.
  if (!isCodeQualifiedNameOf(qualifiedName, filePath)) {
    out.push({
      id,
      qualifiedName,
      reason:
        `code row must be rooted at its filePath (${JSON.stringify(filePath)}) and joined with ` +
        `${JSON.stringify(CODE_QUALIFIED_NAME_SEPARATOR)} — parsers.ts buildCodeQualifiedName`,
    });
  }
  return out;
}

/** Check ONE table/column row against the schema-graph writer's own helpers. */
function checkSchemaSymbol(table: FixtureTable): NameConventionViolation[] {
  const out: NameConventionViolation[] = [];
  if (!INGEST_SYMBOL_KINDS.has(table.kind)) {
    out.push({
      id: table.id,
      qualifiedName: table.qualifiedName,
      reason: `kind ${JSON.stringify(table.kind)} is not a schema-graph.ts writer kind`,
    });
    return out;
  }
  if (table.kind === "column") {
    // A column's identity is `<table-qn>.<column>`; the corpus carries the joined
    // name, so re-derive from its own segments rather than inventing a table.
    const lastDot = table.qualifiedName.lastIndexOf(".");
    const parent = lastDot > 0 ? table.qualifiedName.slice(0, lastDot) : "";
    const expected = columnQualifiedName(undefined, parent, table.name);
    if (table.qualifiedName !== expected) {
      out.push({
        id: table.id,
        qualifiedName: table.qualifiedName,
        reason: `column row must equal ${JSON.stringify(expected)} — schema-graph.ts columnQualifiedName`,
      });
    }
    return out;
  }
  // Tables and routines share the `<schema>.<name>` shape; the corpus is
  // single-schema, so the qualified name is the normalized bare name.
  const expected = tableQualifiedName(undefined, table.name);
  if (table.qualifiedName !== expected) {
    out.push({
      id: table.id,
      qualifiedName: table.qualifiedName,
      reason: `${table.kind} row must equal ${JSON.stringify(expected)} — schema-graph.ts tableQualifiedName`,
    });
  }
  return out;
}

/**
 * Compare a corpus manifest against the qualified-name shapes the REAL ingest
 * emitters produce. Pure: returns every violation rather than throwing on the
 * first, so a corpus author sees the whole picture in one run.
 */
export function checkCorpusNameConvention(manifest: ImpactRecallManifest): NameConventionReport {
  const violations: NameConventionViolation[] = [];
  let productionShapedCount = 0;

  for (const symbol of manifest.codeSymbols ?? []) {
    violations.push(...checkCodeSymbol(symbol));
    if (
      symbol.language !== SQL_LANGUAGE &&
      symbol.qualifiedName.includes(CODE_QUALIFIED_NAME_SEPARATOR)
    ) {
      productionShapedCount += 1;
    }
  }
  for (const table of manifest.tables ?? []) {
    violations.push(...checkSchemaSymbol(table));
  }

  if (productionShapedCount === 0) {
    violations.push({
      id: manifest.id,
      qualifiedName: "(corpus)",
      reason:
        "no code symbol uses the production " +
        `${JSON.stringify(CODE_QUALIFIED_NAME_SEPARATOR)} shape, so this corpus cannot exercise ` +
        "convention-sensitive code (the #1002 blind spot)",
    });
  }

  return {
    violations,
    checkedCount: (manifest.codeSymbols?.length ?? 0) + (manifest.tables?.length ?? 0),
    productionShapedCount,
  };
}

/** Violations rendered as a single actionable multi-line message. */
export function formatNameConventionViolations(report: NameConventionReport): string {
  return report.violations.map((v) => `  - ${v.id} ${v.qualifiedName}: ${v.reason}`).join("\n");
}

/**
 * Throw unless the corpus matches what ingest emits. The harness calls this BEFORE
 * measuring anything: a corpus that models a different world must fail loudly, not
 * silently report numbers for it.
 */
export function assertCorpusNameConvention(manifest: ImpactRecallManifest): void {
  const report = checkCorpusNameConvention(manifest);
  if (report.violations.length === 0) return;
  throw new Error(
    `impact-recall corpus ${JSON.stringify(manifest.id)} does not match the qualified-name ` +
      `convention the ingest emitters produce (#1016). ${report.violations.length} of ` +
      `${report.checkedCount} rows are wrong:\n${formatNameConventionViolations(report)}\n` +
      "Fix the corpus (or, if ingest genuinely changed, update code-graph/qualified-name.ts " +
      "and re-generate the corpus) — do NOT relax this check: it is the only thing standing " +
      "between the eval and measuring a world that does not ship.",
  );
}
