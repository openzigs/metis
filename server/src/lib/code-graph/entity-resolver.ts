/**
 * Entity → physical-table resolver — Epic #883 (#896).
 *
 * ORM query lineage (JPA/Hibernate HQL/JPQL, Spring Data derived queries;
 * eventually SQLAlchemy ORM #898 and EF-Core #900) references entities by
 * NAME — a class, not a table. The ORM *shape* extractor (`orm-extractor.ts`,
 * #850/#872) already knows how one entity maps onto a physical table/column
 * (`@Entity`/`@Table(name=)`/`@Column(name=)`), but that knowledge lives only
 * inside its own per-file loop; nothing let the QUERY side ask "what table
 * does entity `Customer` map to?" by name. This module is that reusable
 * lookup, kept deliberately framework-agnostic:
 *
 *   - {@link EntityTableResolver} — the interface query extractors code
 *     against. JPA/Hibernate ({@link buildJpaEntityResolver}) is the first
 *     implementation; SQLAlchemy ORM (#898) and EF-Core (#900) plug into the
 *     SAME interface by feeding their own entity/field maps into
 *     {@link MapEntityTableResolver} — no framework-specific branching needs
 *     to leak outside this file's `build*EntityResolver` factories.
 *   - {@link MapEntityTableResolver} — a generic in-memory implementation
 *     keyed by entity name (simple class/model name, fully-qualified name, or
 *     an explicit framework alias such as JPA's `@Entity(name=...)`).
 *     Ambiguous registrations (two different tables claiming the SAME name)
 *     resolve to `null` rather than silently picking one — callers should
 *     prefer a fully-qualified reference when the source language has one.
 *
 * Read-only, no SQL executed: this module only builds an in-memory index from
 * already-parsed entity definitions.
 */
import {
  parseEfDbSets,
  parseEfEntities,
  parseEfFluentTables,
  type EfEntityShape,
} from "./ef-extractor.js";
import { parseJpaEntities } from "./orm-extractor.js";
import { parseSqlAlchemyEntities } from "./sqlalchemy-extractor.js";

/** The physical table a resolved entity reference maps onto. */
export interface ResolvedEntityTable {
  table: string;
  schema?: string;
}

/** The physical column a resolved `entity.field` reference maps onto. */
export interface ResolvedEntityColumn extends ResolvedEntityTable {
  column: string;
}

/**
 * Framework-agnostic entity → physical-table resolver. Every ORM query
 * extractor (JPA HQL/JPQL + Spring Data derived queries today; SQLAlchemy
 * ORM #898 and EF-Core #900 tomorrow) resolves entity/field references
 * through this SAME shape, so the query-parsing side never needs to know
 * which framework produced the underlying entity map.
 */
export interface EntityTableResolver {
  /**
   * Resolve an entity reference — a bare class/model name (`Customer`) or a
   * fully-qualified one (`com.example.domain.Customer`) — to its physical
   * table. Returns `null` when the entity is unknown OR the name is
   * ambiguous (two different entities registered the same name with
   * different tables).
   */
  resolveEntity(entityRef: string): ResolvedEntityTable | null;
  /**
   * Resolve `<entityRef>.<fieldName>` to its physical column. Returns `null`
   * when the entity is unknown/ambiguous, the field isn't mapped to a column
   * (e.g. `@Transient`, or a `@OneToMany` collection with no owning FK), or
   * the field simply doesn't exist on the entity.
   */
  resolveField(entityRef: string, fieldName: string): ResolvedEntityColumn | null;
}

interface EntityIndexEntry {
  table: string;
  schema?: string;
  fields: Map<string, string>;
}

/** Sentinel stored for a name two different entities both claim — resolves to `null`, never guesses. */
const AMBIGUOUS = Symbol("ambiguous-entity-name");

/**
 * Generic in-memory {@link EntityTableResolver}, keyed case-insensitively by
 * entity name. A framework-specific `build*EntityResolver` factory
 * (e.g. {@link buildJpaEntityResolver}) populates it via {@link register}.
 */
export class MapEntityTableResolver implements EntityTableResolver {
  private readonly byName = new Map<string, EntityIndexEntry | typeof AMBIGUOUS>();

  /**
   * Register one entity under a resolvable name — a simple name, a
   * fully-qualified name, or an explicit framework alias. Registering the
   * SAME name again with a DIFFERENT physical table marks it ambiguous
   * (future lookups return `null`) instead of silently keeping whichever
   * registration happened to come first.
   */
  register(name: string | undefined | null, entry: EntityIndexEntry): void {
    if (!name) return;
    const key = name.toLowerCase();
    const existing = this.byName.get(key);
    if (existing === undefined) {
      this.byName.set(key, entry);
    } else if (
      existing !== AMBIGUOUS &&
      (existing.table !== entry.table || existing.schema !== entry.schema)
    ) {
      this.byName.set(key, AMBIGUOUS);
    }
  }

  resolveEntity(entityRef: string): ResolvedEntityTable | null {
    const entry = this.lookup(entityRef);
    return entry ? { table: entry.table, schema: entry.schema } : null;
  }

  resolveField(entityRef: string, fieldName: string): ResolvedEntityColumn | null {
    if (!fieldName) return null;
    const entry = this.lookup(entityRef);
    if (!entry) return null;
    const column = entry.fields.get(fieldName.toLowerCase());
    if (!column) return null;
    return { table: entry.table, schema: entry.schema, column };
  }

  private lookup(entityRef: string): EntityIndexEntry | null {
    if (!entityRef) return null;
    const exact = this.byName.get(entityRef.toLowerCase());
    if (exact !== undefined) return exact === AMBIGUOUS ? null : exact;
    // Fall back to the last dotted segment (a caller passing a FQCN we only
    // ever registered under its simple name, or vice versa).
    const simple = entityRef.split(".").pop() ?? entityRef;
    const bySimple = this.byName.get(simple.toLowerCase());
    return bySimple === undefined || bySimple === AMBIGUOUS ? null : bySimple;
  }
}

// Matches an explicit JPA entity-name override associated with the NEXT
// `class` declaration: `@Entity("Foo")` or `@Entity(name = "Foo")`. Bare
// `@Entity` (no parens) never matches, which is the common case — the entity
// name then defaults to the class's simple name (handled by the caller).
const EXPLICIT_ENTITY_NAME_RE =
  /@Entity\s*\(\s*(?:name\s*=\s*)?["']([^"']+)["'][^)]*\)[\s\S]*?\bclass\s+(\w+)/g;

/** Map `className -> explicit @Entity(name=...) alias`, scanned once per file. */
function explicitJpaEntityNames(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let m: RegExpExecArray | null;
  EXPLICIT_ENTITY_NAME_RE.lastIndex = 0;
  while ((m = EXPLICIT_ENTITY_NAME_RE.exec(content)) !== null) {
    out.set(m[2], m[1]);
  }
  return out;
}

/**
 * Build an {@link EntityTableResolver} for JPA/Hibernate from captured `.java`
 * sources, reusing {@link parseJpaEntities} (the SAME entity-shape parser the
 * ORM schema pass persists from, #850) rather than duplicating its
 * `@Entity`/`@Table`/`@Column` regex logic. Each entity is registered under
 * its simple class name, its fully-qualified name, and — when present — its
 * explicit `@Entity(name=...)` alias, so HQL/JPQL (which references the JPA
 * entity name, defaulting to the simple class name) and Spring Data derived
 * queries (which reference the repository's declared generic entity type,
 * also the simple class name) both resolve.
 */
export function buildJpaEntityResolver(
  javaSources: ReadonlyMap<string, string>,
): MapEntityTableResolver {
  const resolver = new MapEntityTableResolver();
  for (const [, content] of javaSources) {
    if (!/@Entity\b/.test(content)) continue;
    const aliases = explicitJpaEntityNames(content);
    for (const entity of parseJpaEntities(content)) {
      const fields = new Map<string, string>();
      for (const f of entity.fields) fields.set(f.field.toLowerCase(), f.column);
      const entry: EntityIndexEntry = { table: entity.table, schema: entity.schema, fields };
      const simpleName = entity.entityName.split(".").pop() ?? entity.entityName;
      resolver.register(simpleName, entry);
      resolver.register(entity.entityName, entry);
      const alias = aliases.get(simpleName);
      if (alias) resolver.register(alias, entry);
    }
  }
  return resolver;
}

/**
 * Build an {@link EntityTableResolver} for SQLAlchemy from captured `.py`
 * sources (#898), reusing {@link parseSqlAlchemyEntities} (which handles BOTH
 * ORM declarative classes via `__tablename__`/`Column` AND Core `Table(...)`
 * variable bindings) rather than duplicating any table/column mapping logic —
 * SQLAlchemy plugs into the SAME framework-agnostic interface {@link
 * buildJpaEntityResolver} does. Each entity is registered under its resolvable
 * name (the ORM class name or the Core `Table` variable name), so both
 * `session.query(User)` (class) and `select(users)` (Core variable) resolve.
 * Read-only — builds an in-memory index from already-parsed definitions.
 */
export function buildSqlAlchemyEntityResolver(
  pySources: ReadonlyMap<string, string>,
): MapEntityTableResolver {
  const resolver = new MapEntityTableResolver();
  for (const [, content] of pySources) {
    // Cheap gate: skip files with no SQLAlchemy declaration markers at all.
    if (!/__tablename__|\bTable\s*\(|\bColumn\s*\(|\bmapped_column\s*\(/.test(content)) continue;
    for (const entity of parseSqlAlchemyEntities(content)) {
      const fields = new Map<string, string>();
      for (const f of entity.fields) fields.set(f.field.toLowerCase(), f.column);
      resolver.register(entity.entityName, { table: entity.table, schema: entity.schema, fields });
    }
  }
  return resolver;
}

/**
 * Build an {@link EntityTableResolver} for EF Core from captured `.cs` sources —
 * Issue #900. EF Core is the .NET analogue of JPA: an entity CLASS maps onto a
 * physical table, expressed via `[Table]`/`[Column]` data annotations, `DbSet<T>`
 * declarations on the `DbContext`, and/or fluent `OnModelCreating`
 * `Entity<T>().ToTable(...)` calls. This factory reuses the SAME framework-agnostic
 * {@link MapEntityTableResolver} JPA/SQLAlchemy plug into — it contributes only
 * EF's mapping-precedence logic, not a parallel resolver.
 *
 * Physical-table precedence per entity follows EF Core's own rules: an explicit
 * fluent `ToTable` wins, then a `[Table]` attribute, then the `DbSet<T>`
 * property-name convention (EF Core uses the DbSet property name verbatim — no
 * pluralization), and finally the entity class name. Each entity is registered
 * under its simple class name so a `DbSet<Customer>` call site resolving through
 * the entity type (`Customer`) reaches the table. `[Column]`-mapped fields are
 * registered for column-level resolution too.
 */
export function buildEfCoreEntityResolver(
  csSources: ReadonlyMap<string, string>,
): MapEntityTableResolver {
  const resolver = new MapEntityTableResolver();

  // Aggregate the three mapping sources across ALL files first — a DbContext and
  // its entities routinely live in separate files, so DbSet/fluent facts from
  // one file must resolve an entity declared in another. Shapes are kept as a
  // LIST per class name (NOT collapsed) so two DIFFERENT entities sharing a
  // simple name but mapping to different tables register as a conflict and the
  // resolver marks the name ambiguous (→ resolves to null) rather than silently
  // picking the first.
  const shapesByName = new Map<string, EfEntityShape[]>();
  const dbSetName = new Map<string, string>(); // entity -> DbSet property name
  const fluent = new Map<string, { table: string; schema: string | null }>();

  for (const content of csSources.values()) {
    for (const shape of parseEfEntities(content)) {
      const list = shapesByName.get(shape.className) ?? [];
      list.push(shape);
      shapesByName.set(shape.className, list);
    }
    // DbSet/fluent config is context-level; first declaration per entity wins.
    for (const ds of parseEfDbSets(content)) {
      if (!dbSetName.has(ds.entity)) dbSetName.set(ds.entity, ds.property);
    }
    for (const ft of parseEfFluentTables(content)) {
      if (!fluent.has(ft.entity)) fluent.set(ft.entity, { table: ft.table, schema: ft.schema });
    }
  }

  // The universe of entities is every class that carries ANY EF signal: a
  // `[Table]` attribute, a `DbSet<T>`, or a fluent mapping. A plain POCO with no
  // signal is not treated as an entity (no table is fabricated for it).
  const entityNames = new Set<string>([...dbSetName.keys(), ...fluent.keys()]);
  for (const [name, list] of shapesByName) {
    if (list.some((s) => s.attrTable)) entityNames.add(name);
  }

  const fieldsOf = (shape: EfEntityShape): Map<string, string> => {
    const fields = new Map<string, string>();
    for (const f of shape.fields) fields.set(f.field.toLowerCase(), f.column);
    return fields;
  };

  for (const name of entityNames) {
    const fl = fluent.get(name);
    const shapes = shapesByName.get(name) ?? [];
    if (shapes.length === 0) {
      // Entity known only via a DbSet/fluent mapping (its class lives in an
      // unparsed file) — one registration, no `[Column]` fields.
      const table = (fl?.table ?? dbSetName.get(name) ?? name).toLowerCase();
      resolver.register(name, { table, schema: fl?.schema?.toLowerCase(), fields: new Map() });
      continue;
    }
    // Register PER shape so conflicting `[Table]` values across same-named
    // classes surface as ambiguity (an explicit fluent override collapses them
    // to one table, so it is never spuriously ambiguous).
    for (const shape of shapes) {
      const table = (fl?.table ?? shape.attrTable ?? dbSetName.get(name) ?? name).toLowerCase();
      const schema = (fl?.schema ?? shape.attrSchema ?? undefined)?.toLowerCase();
      resolver.register(name, { table, schema, fields: fieldsOf(shape) });
    }
  }

  return resolver;
}
