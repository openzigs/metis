/**
 * EF Core entity-shape extractor — Issue #900 (Epic #883).
 *
 * Entity Framework Core maps a C# entity CLASS onto a physical table. Unlike a
 * jOOQ generated table class (#897, a query-builder handle) an EF entity is a
 * user-authored persistence declaration — the direct .NET analogue of a JPA
 * `@Entity` (#896). This module parses the three places EF expresses that
 * mapping, purely statically (no Roslyn, no reflection, read-only):
 *
 *   1. **Data annotations** — `[Table("customers", Schema = "sales")]` on the
 *      class, `[Column("customer_id")]` on a property.
 *   2. **`DbSet<T>` declarations** on a `DbContext` — `public DbSet<Customer>
 *      Customers { get; set; }`. The property name is EF Core's DEFAULT table
 *      name for the entity when no explicit mapping is present (EF Core, unlike
 *      EF6, does not pluralize — the DbSet property name is used verbatim).
 *   3. **Fluent API** in `OnModelCreating` — `modelBuilder.Entity<Customer>()
 *      .ToTable("cust_tbl")` (also the lambda form `Entity<Customer>(e =>
 *      { e.ToTable("cust_tbl"); })`), including an optional schema
 *      (`ToTable("t", "s")` or `ToTable("t", schema: "s")`).
 *
 * The resolved physical table for an entity follows EF Core's own precedence:
 * explicit fluent `ToTable` > `[Table]` attribute > `DbSet<T>` property-name
 * convention > the entity class name. {@link buildEfCoreEntityResolver}
 * (`entity-resolver.ts`) consumes these shapes and registers them in the SAME
 * framework-agnostic {@link EntityTableResolver} JPA/SQLAlchemy use.
 */
import { sliceBraces, toSnakeCase } from "./orm-extractor.js";

/** A field on an EF entity and the physical column it maps to (from `[Column]`). */
export interface EfFieldRef {
  field: string;
  column: string;
}

/** One EF entity CLASS and the annotation-derived mapping facts parsed from it. */
export interface EfEntityShape {
  /** Simple class name (`Customer`). */
  className: string;
  /** Explicit `[Table(name)]` value, when present. */
  attrTable: string | null;
  /** Explicit `[Table(Schema=...)]` value, when present. */
  attrSchema: string | null;
  /** `[Column]`-mapped fields. */
  fields: EfFieldRef[];
  /** 1-based line of the class declaration. */
  line: number;
}

/** A `DbSet<Entity> Property` declaration on a `DbContext`. */
export interface EfDbSet {
  /** The DbSet property name (`Customers`) — EF's default table name. */
  property: string;
  /** The entity type argument's simple name (`Customer`). */
  entity: string;
}

/** A fluent `modelBuilder.Entity<Entity>()...ToTable(name[, schema])` mapping. */
export interface EfFluentTable {
  entity: string;
  table: string;
  schema: string | null;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Last dotted segment of a type reference (`Foo.Bar.Customer` -> `Customer`). */
function simpleName(typeRef: string): string {
  return typeRef.split(".").pop() ?? typeRef;
}

// A class declaration with the attribute block that immediately precedes it.
// `[\s\S]*?` between attributes and `class` is bounded by the non-greedy match
// terminating at the FIRST `class`; the `(?:\[[^\]]*\]\s*)*` prefix only
// consumes attribute lists, so an unrelated earlier class cannot be captured.
// Each modifier carries its OWN required trailing whitespace (no bare `\s`
// alternative inside the `*`-group) so the pattern is unambiguous and linear —
// no ReDoS surface (OWASP A?: catastrophic backtracking). Same discipline in
// PROPERTY_RE below.
const CLASS_RE =
  /((?:\[[^\]]*\]\s*)*)(?:(?:public|internal|sealed|abstract|partial|static)\s+)*class\s+(\w+)/g;

// `[Table("name")]` / `[Table("name", Schema = "s")]` — the leading positional
// string argument is the table name; a `Schema = "..."` named argument is
// optional and order-independent.
const TABLE_ATTR_RE = /\bTable\s*\(\s*"([^"]+)"(?:[^)]*\bSchema\s*=\s*"([^"]+)")?/;
// `[Column("col")]` — leading positional string is the column name.
const COLUMN_ATTR_RE = /\bColumn\s*\(\s*"([^"]+)"/;
// A property declaration, capturing its preceding attribute block and name:
// `[Column("x")] public int Id { get; set; }`.
const PROPERTY_RE =
  /((?:\[[^\]]*\]\s*)*)(?:(?:public|internal|protected|private|virtual|override|static|readonly)\s+)+[\w.<>,?[\]]+\s+(\w+)\s*\{\s*get\b/g;

/**
 * Parse EF entity CLASSES (their `[Table]`/`[Column]` annotations) from one
 * `.cs` source. A class with no EF signal at all is still returned with null
 * table/empty fields — {@link buildEfCoreEntityResolver} decides whether it is
 * an entity by cross-referencing the DbSet/fluent maps, so this stays a pure
 * shape parser.
 */
export function parseEfEntities(content: string): EfEntityShape[] {
  const out: EfEntityShape[] = [];
  CLASS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_RE.exec(content)) !== null) {
    const attrs = m[1] ?? "";
    const className = m[2];
    const braceIdx = content.indexOf("{", m.index + m[0].length);
    if (braceIdx === -1) continue;
    const body = sliceBraces(content, braceIdx);

    const tableAttr = TABLE_ATTR_RE.exec(attrs);
    const fields: EfFieldRef[] = [];
    PROPERTY_RE.lastIndex = 0;
    let p: RegExpExecArray | null;
    while ((p = PROPERTY_RE.exec(body)) !== null) {
      const propAttrs = p[1] ?? "";
      const propName = p[2];
      const colAttr = COLUMN_ATTR_RE.exec(propAttrs);
      const column = colAttr ? colAttr[1].toLowerCase() : toSnakeCase(propName);
      fields.push({ field: propName, column });
    }

    out.push({
      className,
      attrTable: tableAttr ? tableAttr[1] : null,
      attrSchema: tableAttr && tableAttr[2] ? tableAttr[2] : null,
      fields,
      line: lineOf(content, m.index),
    });
  }
  return out;
}

// `DbSet<Entity> Property` (with optional namespace-qualified entity + modifiers).
const DBSET_RE = /\bDbSet\s*<\s*([\w.]+)\s*>\s+(\w+)/g;

/** Parse `DbSet<Entity> Property` declarations from one `.cs` source. */
export function parseEfDbSets(content: string): EfDbSet[] {
  const out: EfDbSet[] = [];
  DBSET_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DBSET_RE.exec(content)) !== null) {
    out.push({ entity: simpleName(m[1]), property: m[2] });
  }
  return out;
}

// `.Entity<Entity>` — the fluent configuration entry point.
const FLUENT_ENTITY_RE = /\.\s*Entity\s*<\s*([\w.]+)\s*>/g;
// `.ToTable("name")` / `.ToTable("name", "schema")` / `.ToTable("name", schema: "schema")`.
const TO_TABLE_RE = /\.\s*ToTable\s*\(\s*"([^"]+)"(?:\s*,\s*(?:schema\s*:\s*)?"([^"]+)")?/;

/**
 * Parse fluent `modelBuilder.Entity<Entity>()...ToTable(name[, schema])`
 * mappings. For each `.Entity<X>` occurrence a bounded forward window — up to
 * the next `.Entity<` entry point or the enclosing statement's `;`, whichever
 * comes first — is searched for a `.ToTable(...)`, which covers BOTH the direct
 * chain (`.Entity<X>().ToTable("t")`) and the configuration-lambda form
 * (`.Entity<X>(e => { e.ToTable("t"); })`).
 */
export function parseEfFluentTables(content: string): EfFluentTable[] {
  const out: EfFluentTable[] = [];
  // Materialize all entry points first so the bounded forward-window search
  // below cannot disturb the outer iteration's shared regex state.
  const entries = [...content.matchAll(FLUENT_ENTITY_RE)];
  for (let i = 0; i < entries.length; i++) {
    const m = entries[i];
    const entity = simpleName(m[1]);
    const windowStart = (m.index ?? 0) + m[0].length;
    // Bound the search at the next fluent entity entry point or the enclosing
    // statement's `;`, so one entity's ToTable can never be misattributed to
    // another.
    const nextEntryStart =
      i + 1 < entries.length ? (entries[i + 1].index ?? content.length) : content.length;
    const semicolon = content.indexOf(";", windowStart);
    const windowEnd = Math.min(nextEntryStart, semicolon === -1 ? content.length : semicolon);
    const toTable = TO_TABLE_RE.exec(content.slice(windowStart, windowEnd));
    if (toTable) {
      out.push({ entity, table: toTable[1], schema: toTable[2] ?? null });
    }
  }
  return out;
}
