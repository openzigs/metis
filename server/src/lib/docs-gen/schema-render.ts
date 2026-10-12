/**
 * Deterministic renderers of an introspected schema: the Mermaid ER diagram and
 * a table's column table. Pure (no I/O, no provider), so both the database
 * document (`db-schema-synthesizer.ts`) and the architecture document's Data
 * Architecture section (`schema-inventory.ts`, #1061) render a schema the same
 * way from the same code.
 */
import type { DbTableInfo } from "@metis/shared";

/**
 * Default maximum number of tables included in the Mermaid ER diagram.
 * ER diagrams beyond ~50 nodes are unreadable; extra tables are listed in
 * the Table Reference section but omitted from the diagram. Overridable via
 * the `DB_SCHEMA_SYNTH_MAX_TABLES_ER` environment variable.
 */
export const MAX_TABLES_ER = 50;

// ---------------------------------------------------------------------------
// Mermaid ER diagram builder
// ---------------------------------------------------------------------------

/**
 * Build a `erDiagram` Mermaid block from introspected tables.
 *
 * Mermaid ER format:
 *   erDiagram
 *     TABLE_NAME {
 *       type column_name PK
 *       type column_name FK
 *       type column_name
 *     }
 *     TABLE_A ||--o{ TABLE_B : "fk_name"
 */
export function buildErDiagram(tables: DbTableInfo[]): string {
  const lines: string[] = ["erDiagram"];

  // For large schemas only show PK/FK columns so the Mermaid diagram stays
  // within the parser's text-size limits and renders quickly in the browser.
  const pkFkOnly = tables.length > 15;

  for (const table of tables) {
    // Sanitize table name for Mermaid (replace dots/spaces with underscores)
    const safeTableName = sanitizeMermaidId(table.name);

    const cols = pkFkOnly
      ? table.columns.filter((c) => c.isPrimaryKey || c.isForeignKey)
      : table.columns;

    // Only emit an entity block when there are columns to show; entities with
    // no PK/FK still appear in the diagram via their relationship lines.
    if (cols.length > 0) {
      lines.push(`  ${safeTableName} {`);

      for (const col of cols) {
        const safeType = sanitizeMermaidType(col.dataType);
        const safeName = sanitizeMermaidId(col.name);
        const annotations: string[] = [];
        if (col.isPrimaryKey) annotations.push("PK");
        if (col.isForeignKey) annotations.push("FK");
        const annotationStr = annotations.length > 0 ? ` "${annotations.join(", ")}"` : "";
        lines.push(`    ${safeType} ${safeName}${annotationStr}`);
      }

      lines.push("  }");
    }
  }

  // Relationship lines from foreign keys
  for (const table of tables) {
    const safeFromTable = sanitizeMermaidId(table.name);
    for (const fk of table.foreignKeys) {
      const safeToTable = sanitizeMermaidId(fk.refTable);
      const safeFkName = sanitizeMermaidId(fk.name);
      // Many-to-one: current table has FK pointing to ref table (one row)
      lines.push(`  ${safeFromTable} }o--|| ${safeToTable} : "${safeFkName}"`);
    }
  }

  return lines.join("\n");
}

function sanitizeMermaidId(name: string): string {
  // Mermaid identifiers must not contain spaces, dots, or special chars. Every
  // character outside the word set is replaced, so nothing a database names a
  // table, column or key can end the line, close the block or open a string.
  return name.replace(/[^a-zA-Z0-9_]/g, "_") || "_";
}

function sanitizeMermaidType(dataType: string): string {
  // Mermaid types must be word chars only; drop the parenthetical size, from
  // the first `(` to the last `)`. Found by index: the pattern `\(.*\)` rescans
  // from every `(` when there is no `)`, which is quadratic (#1061 review).
  const open = dataType.indexOf("(");
  const close = open < 0 ? -1 : dataType.lastIndexOf(")");
  const bare = close > open ? dataType.slice(0, open) + dataType.slice(close + 1) : dataType;
  return bare.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase() || "text";
}

const CELL_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  "|": "\\|",
  "`": "\\`",
  "*": "\\*",
  "[": "\\[",
  "]": "\\]",
  "<": "&lt;",
};

/**
 * Text from a database (a column name, a type, a default) as the contents of
 * ONE Markdown table cell. A pipe would add a cell and a line break would start
 * a new row, heading or link, so whoever controls the DDL could write rows into
 * the document (#1061 review). Line breaks and tabs become a space; the
 * characters that are Markdown or HTML syntax are escaped, so the value reads
 * as the database holds it. One pass, no backtracking.
 */
export function escapeMarkdownCell(value: string): string {
  return value
    .replace(/[\r\n\t\f\v\u2028\u2029]+/g, " ")
    .replace(/[\\|`*[\]<]/g, (ch) => CELL_ESCAPES[ch])
    .trim();
}

/**
 * The column table of one introspected table, as markdown lines. Shared with
 * the architecture document's Data Architecture section (#1061), so both
 * documents render a table's columns from the schema in the same way.
 */
export function renderColumnTable(table: Pick<DbTableInfo, "columns">): string[] {
  const lines = ["| Column | Type | Constraints |", "|--------|------|-------------|"];
  for (const col of table.columns) {
    const constraints: string[] = [];
    if (col.isPrimaryKey) constraints.push("PK");
    if (col.isForeignKey) constraints.push("FK");
    if (!col.nullable) constraints.push("NOT NULL");
    if (col.defaultValue != null) {
      constraints.push(`DEFAULT: ${escapeMarkdownCell(String(col.defaultValue))}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(col.name)} | ${escapeMarkdownCell(col.dataType)} | ` +
        `${constraints.join(", ")} |`,
    );
  }
  return lines;
}
