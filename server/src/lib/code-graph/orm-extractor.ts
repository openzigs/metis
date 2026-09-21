/**
 * ORM schema extractor — Epic #168 (#171).
 *
 * Maps ORM model definitions onto database tables/columns so an impact run can
 * cross code → entity/model → table → column. Two ORMs are supported:
 *
 *   - JPA / Hibernate (Java): `@Entity` / `@Table(name=)` →table, fields with
 *     `@Column(name=)` / `@Id` / `@JoinColumn(name=)` →columns. A bare field on
 *     an entity defaults to a snake-cased column name.
 *   - Prisma (`schema.prisma`): `model X { ... }` with `@@map("table")` and
 *     per-field `@map("col")` / `@relation`.
 *
 * Every entity→table and field→column link is emitted as a `persists-to` edge
 * with `source = "orm"`. No live DB is consulted; mappings are inferred purely
 * from the source.
 */
import type { SchemaGraphWriter } from "./schema-graph.js";

/** A field on an ORM entity/model and the column it persists to. */
export interface OrmFieldRef {
  field: string;
  column: string;
}

/** One ORM entity/model mapped onto a table. */
export interface OrmEntity {
  /** Fully-qualified entity/model name (`<pkg>.<Class>` or Prisma `model`). */
  entityName: string;
  table: string;
  schema?: string;
  fields: OrmFieldRef[];
  line: number;
}

// ---- helpers ---------------------------------------------------------------

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Convert a camelCase/PascalCase identifier to snake_case (JPA default). */
export function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

// ---- JPA / Hibernate -------------------------------------------------------

const JPA_FIELD_RE =
  /(@[A-Za-z]+(?:\([^)]*\))?\s*)*(?:private|public|protected)\s+[\w.<>,\s[\]]+?\b(\w+)\s*(?:=|;)/g;

function jpaColumnName(annotations: string, field: string): string | null {
  if (/@Transient\b/.test(annotations)) return null;
  const col =
    /@Column\s*\([^)]*\bname\s*=\s*["']([^"']+)["']/.exec(annotations) ??
    /@JoinColumn\s*\([^)]*\bname\s*=\s*["']([^"']+)["']/.exec(annotations);
  if (col) return col[1].toLowerCase();
  return toSnakeCase(field);
}

/** Parse JPA `@Entity` classes out of a Java source file. */
export function parseJpaEntities(content: string): OrmEntity[] {
  if (!/@Entity\b/.test(content)) return [];
  const pkg = /\bpackage\s+([A-Za-z0-9_.]+)\s*;/.exec(content);
  const entities: OrmEntity[] = [];

  const classRe = /@Entity\b[\s\S]*?\bclass\s+(\w+)[^{]*\{/g;
  let c: RegExpExecArray | null;
  while ((c = classRe.exec(content)) !== null) {
    const className = c[1];
    // Slice the class body (balanced braces).
    const bodyStart = c.index + c[0].length - 1;
    const body = sliceBraces(content, bodyStart);
    const header = content.slice(c.index, bodyStart);

    const tableMatch = /@Table\s*\([^)]*\bname\s*=\s*["']([^"']+)["'][^)]*\)/.exec(header) ?? null;
    const schemaMatch = /@Table\s*\([^)]*\bschema\s*=\s*["']([^"']+)["']/.exec(header);
    const table = tableMatch ? tableMatch[1].toLowerCase() : toSnakeCase(className);
    const schema = schemaMatch ? schemaMatch[1].toLowerCase() : undefined;

    const fields: OrmFieldRef[] = [];
    let f: RegExpExecArray | null;
    JPA_FIELD_RE.lastIndex = 0;
    while ((f = JPA_FIELD_RE.exec(body)) !== null) {
      const annotations = f[1] ?? "";
      const fieldName = f[2];
      // Skip obvious non-persisted members (collections of relations are kept
      // as the FK column only when @JoinColumn is present).
      const column = jpaColumnName(annotations, fieldName);
      if (!column) continue;
      if (/@(OneToMany|ManyToMany)\b/.test(annotations) && !/@JoinColumn\b/.test(annotations)) {
        continue;
      }
      fields.push({ field: fieldName, column });
    }

    entities.push({
      entityName: pkg ? `${pkg[1]}.${className}` : className,
      table,
      schema,
      fields,
      line: lineOf(content, c.index),
    });
  }
  return entities;
}

/**
 * Return the `{...}` block starting at `openBraceIndex` (balanced). Exported
 * so other Java-source parsers (e.g. `jpa-query-extractor.ts`'s Spring Data
 * repository interface scan, #896) can slice a class/interface body without
 * duplicating this brace-matcher.
 */
export function sliceBraces(content: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) return content.slice(openBraceIndex + 1, i);
    }
  }
  return content.slice(openBraceIndex + 1);
}

// ---- Prisma ----------------------------------------------------------------

/** Parse Prisma `model` blocks out of a `schema.prisma` file. */
export function parsePrismaModels(content: string): OrmEntity[] {
  const entities: OrmEntity[] = [];
  const modelRe = /\bmodel\s+(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(content)) !== null) {
    const modelName = m[1];
    const bodyStart = m.index + m[0].length - 1;
    const body = sliceBraces(content, bodyStart);
    const mapMatch = /@@map\s*\(\s*["']([^"']+)["']\s*\)/.exec(body);
    const table = mapMatch ? mapMatch[1].toLowerCase() : modelName.toLowerCase();

    const fields: OrmFieldRef[] = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const fieldMatch = /^(\w+)\s+([A-Za-z0-9_[\]?]+)(.*)$/.exec(line);
      if (!fieldMatch) continue;
      const [, fieldName, fieldType, attrs] = fieldMatch;
      // Skip relation fields: an explicit `@relation` (the FK-owning side), or a
      // list of a model type (`Post[]`) which is the inverse side and has no
      // column of its own. Scalar lists (`String[]`) are kept.
      if (/@relation\b/.test(attrs) && !/@map\b/.test(attrs)) continue;
      const baseType = fieldType.replace(/[[\]?]/g, "");
      if (fieldType.endsWith("[]") && /^[A-Z]/.test(baseType)) continue;
      const mapCol = /@map\s*\(\s*["']([^"']+)["']\s*\)/.exec(attrs);
      const column = mapCol ? mapCol[1].toLowerCase() : fieldName.toLowerCase();
      fields.push({ field: fieldName, column });
    }

    entities.push({
      entityName: modelName,
      table,
      fields,
      line: lineOf(content, m.index),
    });
  }
  return entities;
}

/** Dispatch by file type: Prisma schema vs JPA Java source. */
export function extractOrm(filePath: string, content: string): OrmEntity[] {
  if (/\.prisma$/i.test(filePath)) return parsePrismaModels(content);
  if (/\.java$/i.test(filePath)) return parseJpaEntities(content);
  return [];
}

// ---- Persistence -----------------------------------------------------------

/**
 * Persist the ORM schema graph for one file: one `table` symbol per entity, a
 * `column` symbol per mapped field, and a `persists-to` edge from the entity
 * origin symbol to each table/column. Returns the number of edges written.
 */
export async function persistOrmFile(
  writer: SchemaGraphWriter,
  filePath: string,
  content: string,
): Promise<number> {
  const entities = extractOrm(filePath, content);
  let edges = 0;
  for (const entity of entities) {
    const fromId = await writer.createOriginSymbol(
      "method",
      entity.entityName.split(".").pop() ?? entity.entityName,
      entity.entityName,
      filePath,
      entity.line,
    );
    const tableId = await writer.ensureTable(entity.table, "orm", {
      schema: entity.schema,
      filePath,
      line: entity.line,
    });
    await writer.addEdge(fromId, "persists-to", tableId, "orm", {
      toQualifiedName: entity.schema ? `${entity.schema}.${entity.table}` : entity.table,
      filePath,
      line: entity.line,
    });
    edges++;
    for (const field of entity.fields) {
      const colId = await writer.ensureColumn(entity.table, field.column, "orm", {
        schema: entity.schema,
        filePath,
        line: entity.line,
      });
      await writer.addEdge(fromId, "persists-to", colId, "orm", {
        toQualifiedName: `${entity.schema ? `${entity.schema}.` : ""}${entity.table}.${field.column}`,
        filePath,
        line: entity.line,
      });
      edges++;
    }
  }
  return edges;
}
