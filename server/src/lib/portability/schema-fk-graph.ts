/**
 * Schema-driven FK graph for provider-agnostic logical dump/reload.
 *
 * WHY this exists (and does not use `Prisma.dmmf` relation metadata):
 *   In Prisma 7's *runtime* DMMF (`Prisma.dmmf.datamodel`), relation object
 *   fields are slimmed down to `{ name, kind, type, relationName }` — the
 *   `relationFromFields` / `relationToFields` / `isList` properties that older
 *   Prisma versions exposed are NOT present at runtime. (Verified against
 *   @prisma/client@7.8.0 in this repo.) The authoritative, complete source of
 *   FK direction is therefore the Prisma schema text itself, which carries
 *   `@relation(fields: [...], references: [...])` on every owning side.
 *
 * This module parses that schema text into a normalized {@link ModelFkInfo}[]
 * describing each model's scalar fields, its mapped table name, and its
 * outgoing foreign-key edges. It is pure and fully unit-testable without a DB.
 *
 * The parser is intentionally conservative: it recognizes the exact relation
 * syntax this project uses (`@relation([name,] fields: [<cols>], references:
 * [<cols>][, ...])`). It does NOT attempt to be a general Prisma grammar.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** A single scalar (non-relation) field of a model. */
export interface ScalarFieldInfo {
  name: string;
  /** Prisma scalar type: String | Int | Boolean | DateTime | Json | Float | Bytes | BigInt | Decimal | enum-name. */
  type: string;
  isRequired: boolean;
  isId: boolean;
  isList: boolean;
}

/** A single outgoing foreign-key edge (the owning side of a relation). */
export interface FkEdge {
  /** The relation field name (e.g. "workspace"). */
  fieldName: string;
  /** The referenced model name (e.g. "Workspace"). */
  referencedModel: string;
  /** The local scalar columns holding the FK (e.g. ["workspaceId"]). */
  fields: string[];
  /** The referenced columns on the target (e.g. ["id"]). */
  references: string[];
  /** True when every FK column is required (non-nullable). A nullable FK can be deferred. */
  isRequired: boolean;
}

/** Normalized per-model descriptor used by the ordering + dump logic. */
export interface ModelFkInfo {
  /** Prisma model name (PascalCase). */
  name: string;
  /** Mapped table name from `@@map(...)`, or the model name when unmapped. */
  tableName: string;
  scalarFields: ScalarFieldInfo[];
  /** Outgoing FK edges (this model references another, or itself). */
  fkEdges: FkEdge[];
  /**
   * Primary-key column(s). A single-element array for a `@id` field, multiple
   * elements for a `@@id([a, b])` composite key. Used for stable cursor/keyset
   * ordering on export and for `where` clauses on the deferred-FK UPDATE pass.
   */
  primaryKey: string[];
}

// ── Parser ──────────────────────────────────────────────────────────────────

const MAP_RE = /@@map\(\s*"([^"]+)"\s*\)/;
const COMPOSITE_ID_RE = /@@id\(\s*\[([^\]]*)\]/;
const RELATION_RE =
  /@relation\(\s*(?:"[^"]*"\s*,\s*)?fields:\s*\[([^\]]*)\]\s*,\s*references:\s*\[([^\]]*)\]/;

/**
 * Loud-guard detectors. The parser only models the EXACT owning-side syntax this
 * project uses ({@link RELATION_RE}). Two valid-Prisma shapes it does NOT model
 * would otherwise be SILENTLY dropped, corrupting the FK load order:
 *
 *   1. Reversed argument order: `@relation(references: [...], fields: [...])`.
 *   2. A multi-line `@relation( ... )` block spanning several physical lines.
 *
 * Rather than mis-order data, we DETECT these on a per-line basis and THROW.
 */
const RELATION_WITH_REFS_BEFORE_FIELDS_RE =
  /@relation\([^)]*\breferences:\s*\[[^\]]*\][^)]*\bfields:\s*\[/;
// An `@relation(` whose closing `)` is NOT on the same physical line.
const RELATION_OPEN_RE = /@relation\(/;

const SCALAR_TYPES = new Set([
  "String",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "Boolean",
  "DateTime",
  "Json",
  "Bytes",
]);

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse a Prisma schema string into normalized {@link ModelFkInfo}[].
 *
 * Recognizes:
 *   - `model X { ... }` blocks (ignores datasource/generator/enum blocks)
 *   - scalar fields with optional `?` (nullable), `[]` (list), `@id`
 *   - `@@map("table")` for table-name resolution
 *   - owning-side relations: `@relation([name,] fields: [...], references: [...])`
 *
 * Enum-typed fields are reported as scalar fields whose `type` is the enum
 * name (they round-trip as strings). The referenced model of an FK is the
 * declared field type of the relation field.
 */
export function parsePrismaSchema(schema: string): ModelFkInfo[] {
  const text = schema;

  // First pass: collect declared model + enum names so a field's type token can
  // be classified UNAMBIGUOUSLY (relation-to-a-model vs. enum vs. scalar) rather
  // than guessed by capitalization. A future enum then surfaces loudly instead
  // of being silently dropped (see {@link isEnumish}).
  const modelNames = new Set<string>();
  const enumNames = new Set<string>();
  const declRe = /\b(model|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let declMatch: RegExpExecArray | null;
  while ((declMatch = declRe.exec(text)) !== null) {
    if (declMatch[1] === "model") modelNames.add(declMatch[2]);
    else enumNames.add(declMatch[2]);
  }

  // Extract each `model <Name> { <body> }` block. Brace-balanced scan so a body
  // on a single line (`model A { id String @id }`) parses identically to a
  // multi-line block. Non-model blocks (datasource/generator/enum) are ignored.
  const models: ModelFkInfo[] = [];
  const openRe = /\bmodel\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;

  let match: RegExpExecArray | null;
  while ((match = openRe.exec(text)) !== null) {
    const name = match[1];
    // Find the matching closing brace from just after the opening `{`.
    let depth = 1;
    let i = openRe.lastIndex;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    const body = text.slice(openRe.lastIndex, i - 1);
    models.push(parseModelBody(name, body, modelNames, enumNames));
    openRe.lastIndex = i;
  }

  return models;
}

/**
 * Strip a trailing `//` line comment WITHOUT corrupting a `//` that appears
 * inside a double-quoted string literal (e.g. a URL default like
 * `@default("https://example.com")`). Walks the line, tracking whether we are
 * inside a `"…"` string, and cuts at the first `//` seen OUTSIDE a string.
 */
export function stripLineComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") {
      inString = !inString;
      continue;
    }
    if (!inString && ch === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseModelBody(
  name: string,
  body: string,
  modelNames: ReadonlySet<string>,
  enumNames: ReadonlySet<string>,
): ModelFkInfo {
  const current: ModelFkInfo = {
    name,
    tableName: name,
    scalarFields: [],
    fkEdges: [],
    primaryKey: [],
  };
  let singleIdField: string | null = null;
  let compositeId: string[] | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = stripLineComment(rawLine); // strip line comments (string-safe)
    if (line.trim().length === 0) continue;

    // ── Loud guards for @relation shapes the parser does NOT model ──────────
    // A multi-line `@relation( ... )` whose closing `)` is on a later line would
    // be silently dropped by the single-line RELATION_RE. Detect and throw.
    if (RELATION_OPEN_RE.test(line) && !line.includes(")")) {
      throw new Error(
        `schema-fk-graph: model "${name}" has a multi-line @relation(...) block, ` +
          `which this parser does not model and would silently mis-order on load. ` +
          `Collapse it onto one line, or extend the parser. Line: ${line.trim()}`,
      );
    }
    // A reversed-argument-order owning relation (`references:` before `fields:`)
    // is valid Prisma but RELATION_RE won't match it → it would be dropped.
    if (RELATION_WITH_REFS_BEFORE_FIELDS_RE.test(line) && !RELATION_RE.test(line)) {
      throw new Error(
        `schema-fk-graph: model "${name}" has an owning @relation with ` +
          `references: before fields:, which this parser does not model and would ` +
          `silently drop the FK edge. Reorder to fields: then references:, or ` +
          `extend the parser. Line: ${line.trim()}`,
      );
    }

    const mapMatch = MAP_RE.exec(line);
    if (mapMatch) current.tableName = mapMatch[1];

    const idMatch = COMPOSITE_ID_RE.exec(line);
    if (idMatch) compositeId = splitList(idMatch[1]);

    if (line.trimStart().startsWith("@@")) continue; // block attribute, not a field

    // A field line begins with an identifier followed by a type token.
    const fieldMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?/.exec(
      line,
    );
    if (!fieldMatch) continue;

    const fieldName = fieldMatch[1];
    const typeToken = fieldMatch[2];
    const isList = Boolean(fieldMatch[3]);
    const isOptional = Boolean(fieldMatch[4]);

    const relMatch = RELATION_RE.exec(line);
    if (relMatch) {
      // Owning side of a relation. Referenced model = the declared field type.
      current.fkEdges.push({
        fieldName,
        referencedModel: typeToken,
        fields: splitList(relMatch[1]),
        references: splitList(relMatch[2]),
        isRequired: !isOptional,
      });
    } else if (SCALAR_TYPES.has(typeToken)) {
      // Built-in scalar field.
      const isId = /(?<!@)@id\b/.test(line);
      if (isId) singleIdField = fieldName;
      current.scalarFields.push({
        name: fieldName,
        type: typeToken,
        isRequired: !isOptional && !isList,
        isId,
        isList,
      });
    } else if (enumNames.has(typeToken)) {
      // Enum-typed field (enum values round-trip as strings).
      const isId = /(?<!@)@id\b/.test(line);
      if (isId) singleIdField = fieldName;
      current.scalarFields.push({
        name: fieldName,
        type: typeToken,
        isRequired: !isOptional && !isList,
        isId,
        isList,
      });
    } else if (modelNames.has(typeToken)) {
      // A relation object field. The OWNING side carries `@relation(fields:)`
      // (handled above); reaching here means this is the INVERSE side (back-
      // reference) — it holds no column data, so it is intentionally skipped.
    } else if (isEnumish(typeToken, enumNames)) {
      // Defensive; isEnumish only returns true for a declared enum.
      const isId = /(?<!@)@id\b/.test(line);
      if (isId) singleIdField = fieldName;
      current.scalarFields.push({
        name: fieldName,
        type: typeToken,
        isRequired: !isOptional && !isList,
        isId,
        isList,
      });
    } else {
      // A field whose type is neither a known scalar, nor a declared enum, nor a
      // declared model. We cannot classify it — silently dropping it could lose
      // a column's data. FAIL LOUDLY so the parser is extended deliberately.
      throw new Error(
        `schema-fk-graph: model "${name}" field "${fieldName}" has unrecognized ` +
          `type "${typeToken}" (not a built-in scalar, declared enum, or declared ` +
          `model). Refusing to silently drop it. Extend the parser or the scalar/` +
          `enum registry. Line: ${line.trim()}`,
      );
    }
  }

  // Resolve the primary key: a composite `@@id([...])` wins; otherwise the
  // single `@id` field; otherwise fall back to a conventional "id" column.
  current.primaryKey =
    compositeId && compositeId.length > 0 ? compositeId : singleIdField ? [singleIdField] : ["id"];

  return current;
}

/**
 * Positively identify an enum-typed field by checking the type token against the
 * set of enum names DECLARED in the schema (parsed in {@link parsePrismaSchema}).
 * Enum values round-trip as strings. This replaces the old always-false heuristic
 * that would have silently dropped a future enum column from the dump.
 *
 * In practice this project currently has zero enum types in the SQLite schema
 * (verified: all scalar types are String/Int/Boolean/DateTime/Json/Float). If an
 * enum is ever added, it is now captured rather than dropped — and any type token
 * that is neither scalar, enum, nor model causes {@link parseModelBody} to THROW.
 */
function isEnumish(typeToken: string, enumNames: ReadonlySet<string>): boolean {
  return enumNames.has(typeToken);
}

/**
 * Cross-check the parser's relation coverage against the runtime DMMF. Every
 * relation field present on a model in `dmmfModels` must be ACCOUNTED FOR by the
 * parser — either matched to a parsed owning-side FK edge, or recognized as the
 * inverse (back-reference) side. If a relation field is neither, the parser must
 * have silently dropped an owning edge (e.g. an unmodeled `@relation` syntax) and
 * we FAIL LOUDLY rather than produce a wrong load order.
 *
 * @param parsed     output of {@link parsePrismaSchema}
 * @param dmmfModels `Prisma.dmmf.datamodel.models` (slimmed runtime shape:
 *                   `{ name, fields: [{ name, kind, type, relationName }] }`).
 */
export function assertParserCoversDmmfRelations(
  parsed: ModelFkInfo[],
  dmmfModels: ReadonlyArray<{
    name: string;
    fields: ReadonlyArray<{ name: string; kind: string; type: string; relationName?: string }>;
  }>,
): void {
  const parsedByModel = new Map(parsed.map((m) => [m.name, m]));
  // Set of "<model>::<relationName>" the parser captured as an owning edge.
  const ownedRelationNames = new Set<string>();
  for (const m of parsed) {
    for (const e of m.fkEdges) {
      // We key the inverse-side match on relationName below; record owning edges
      // by both the owning field and (model,referenced) so we can match inverses.
      ownedRelationNames.add(`${m.name}::${e.fieldName}`);
    }
  }

  const errors: string[] = [];
  for (const dm of dmmfModels) {
    const pm = parsedByModel.get(dm.name);
    if (!pm) {
      // A model present in DMMF but not parsed → schema/parser drift.
      errors.push(`model "${dm.name}" is in the DMMF but was not parsed from the schema text`);
      continue;
    }
    const ownedFieldNames = new Set(pm.fkEdges.map((e) => e.fieldName));
    for (const f of dm.fields) {
      if (f.kind !== "object") continue; // only relation (object) fields
      // The owning side is the one with a parsed FK edge of the same field name.
      if (ownedFieldNames.has(f.name)) continue;
      // Otherwise it must be an INVERSE side: a relation field whose referenced
      // type is a known model and which carries no scalar FK columns. In the
      // slimmed DMMF the inverse side has no relationFromFields, and the parser
      // intentionally skips it. We accept it ONLY if SOME side of this relation
      // was captured as owning (so the relation is represented somewhere) — i.e.
      // the related model owns it. If the related model also lacks an owning edge
      // for this relationName, the FK was dropped entirely → fail loudly.
      const related = parsedByModel.get(f.type);
      const relatedOwns =
        related?.fkEdges.some((e) => e.referencedModel === dm.name) ??
        // self-relation: an owning edge on the same model referencing itself
        pm.fkEdges.some((e) => e.referencedModel === dm.name);
      if (!relatedOwns) {
        errors.push(
          `relation field "${dm.name}.${f.name}" (-> ${f.type}) is present in the ` +
            `DMMF but neither it nor the inverse side was captured as an owning FK ` +
            `edge by the parser — an owning @relation was likely silently dropped`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `schema-fk-graph: parser/DMMF relation coverage check FAILED:\n  - ${errors.join("\n  - ")}`,
    );
  }
}
