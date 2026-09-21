/**
 * Schema impact crossing + DDL suggestion — Epic #168 (#173).
 *
 * The code-side engine (#162) resolves the requirement change to a blast radius
 * of affected code symbols. This module crosses that blast radius into the
 * schema graph: it follows the `reads` / `writes` / `persists-to` edges (#170,
 * #171, #172) from each impacted code symbol to the `table` / `column` symbols
 * it touches, reconciles them against the live schema when available, and emits
 * a syntactically-plausible **suggested DDL string per affected table/column —
 * TEXT ONLY, never executed**.
 *
 * The schema crossing uses a DEDICATED data source querying only the schema
 * edge kinds, so the code blast radius (`calls|imports|defines|references`)
 * stays uncontaminated and vice-versa.
 */
import type { PrismaClient } from "@prisma/client";
import type {
  DdlChangeKind,
  SchemaEdgeKind,
  SchemaReconciliation,
  SchemaSource,
  UsageObjectKind,
} from "@metis/shared";
import { SCHEMA_IMPACT_EDGE_KINDS, isLiveSchemaSource } from "@metis/shared";
import type { LiveSchemaIndex } from "./live-schema-ingest.js";

/**
 * A schema symbol reachable from impacted code: a `table`/`column` (#168) or, as
 * of Epic #293 Phase 2 (#302), a `procedure`/`function` routine invoked by the
 * impacted code via an `executes` edge.
 */
interface SchemaSymbolRow {
  id: string;
  kind: "table" | "column" | "procedure" | "function";
  name: string;
  qualifiedName: string;
  source: SchemaSource | null;
}

interface SchemaEdgeRow {
  fromSymbolId: string;
  toSymbolId: string;
  kind: SchemaEdgeKind;
}

/**
 * #928 — a downstream CODE edge (`calls`/`executes`) used to walk from an
 * impacted code symbol INTO the data-access layer (mapper/DAO methods and the
 * MyBatis statement symbols they `executes`). Only the endpoints are needed for
 * the reachability BFS, so the edge kind is intentionally omitted.
 */
interface DownstreamCodeEdgeRow {
  fromSymbolId: string;
  toSymbolId: string;
}

/**
 * #928 — the code-graph edge kinds followed DOWNSTREAM from an impacted symbol to
 * reach the data-access layer: `calls` (service → mapper/DAO method) and
 * `executes` (mapper method → its MyBatis statement symbol). Distinct from
 * {@link SCHEMA_IMPACT_EDGE_KINDS} (the reads/writes/persists-to crossing) — this
 * set only *expands reachability*; it never surfaces a table by itself.
 */
const DOWNSTREAM_CALL_EDGE_KINDS = ["calls", "executes"] as const;

/**
 * A code symbol's identity used by DAO/mapper sibling expansion (#922): just
 * enough to recognise a mapper/DAO method and locate the enclosing type. NOT a
 * schema symbol — these are `method`/`class`/etc. code nodes, not tables.
 */
export interface CodeSymbolIdentity {
  id: string;
  kind: string;
  /** Fully-qualified name, e.g. `org.jpetstore.mapper.AccountMapper.updateProfile`. */
  qualifiedName: string;
}

/** Read-only schema-graph access scoped to one project (injectable for tests). */
export interface SchemaImpactDataSource {
  /**
   * Schema edges originating from the given code symbols. Includes the
   * table/column edge kinds (`reads`/`writes`/`persists-to`, #168) AND the
   * code→routine `executes` edge kind (#302) so impacted code surfaces both the
   * tables/columns and the procedures/functions it touches.
   */
  getSchemaEdgesFrom(symbolIds: string[]): Promise<SchemaEdgeRow[]>;
  /** Resolve `table`/`column`/`procedure`/`function` symbols by id. */
  getSchemaSymbolsByIds(ids: string[]): Promise<SchemaSymbolRow[]>;
  /**
   * #922 — resolve the code-symbol identity (kind + qualifiedName) for the given
   * seed ids so DAO/mapper sibling expansion can recognise mapper methods. Read-
   * only. Optional: when absent, sibling expansion is silently skipped (behaviour
   * identical to before #922).
   */
  getCodeSymbolsByIds?(ids: string[]): Promise<CodeSymbolIdentity[]>;
  /**
   * #922 — return the `method` symbols whose enclosing type (the qualifiedName up
   * to the last `.`) is one of `enclosingTypes`. Used to find the sibling methods
   * of an impacted mapper/DAO method. Read-only. Optional: when absent, sibling
   * expansion is silently skipped.
   */
  getSiblingMethodIds?(enclosingTypes: string[]): Promise<CodeSymbolIdentity[]>;
  /**
   * #928 — downstream code edges (`calls`/`executes`) FROM the given symbols,
   * used to walk from impacted code into the data-access layer so a mapper/DAO
   * method and its MyBatis statement symbol enter the crossing set even though
   * the code-impact blast radius stayed UPSTREAM (callers). Read-only. Optional:
   * when absent, {@link crossToSchema} degrades to its pre-#928 single-hop
   * crossing (the seeds themselves must directly own the schema edges).
   */
  getDownstreamCallEdgesFrom?(symbolIds: string[]): Promise<DownstreamCodeEdgeRow[]>;
}

/** The row data persisted to `ImpactAffectedTable` (id/impactItemId added later). */
export interface AffectedTableInput {
  /** Object kind — `table`/`column` (#168) or `procedure`/`function` (#302). */
  objectKind: UsageObjectKind;
  tableName: string;
  columnName: string | null;
  columnType: string | null;
  changeKind: DdlChangeKind;
  suggestedDdl: string | null;
  source: SchemaSource;
  reconciliation: SchemaReconciliation | null;
  confidence: number;
  /**
   * Epic #295 Phase 4 (#308) — canonical cross-project identity id for this
   * object, populated ONLY when a {@link CrossProjectIdentityResolver} is passed
   * (i.e. the item's project belongs to a workspace with a DatabaseResource).
   * Null/undefined in the common case (no workspace/resource context) so the
   * Phase-1 behavior is unchanged.
   */
  schemaObjectIdentityId?: string | null;
  /**
   * #922 — true when this row was surfaced ONLY via DAO/mapper sibling expansion
   * (a sibling method of the impacted mapper touches it), not by a directly
   * impacted symbol. Sibling-derived rows carry a deliberately reduced
   * {@link confidence} to preserve precision. In-memory marker for callers/UI —
   * NOT persisted (no schema column), so omitting it from a `createMany` map is
   * expected. Undefined/false means the row was crossed directly.
   */
  siblingDerived?: boolean;
  /**
   * #936 — the LLM relevance tier assigned by the output relevance filter
   * (`likely`/`possible` ⇒ primary set, `unlikely` ⇒ secondary bucket).
   * PERSISTED to `ImpactAffectedTable.relevanceTier` (own column) so the read
   * path splits primary vs secondary in the API/UI, not just in memory.
   * Undefined when the filter did not run (deterministic passthrough) ⇒ NULL
   * column ⇒ read into the primary set exactly like a legacy row.
   */
  relevanceTier?: "likely" | "possible" | "unlikely";
  /**
   * #936 — one-line LLM rationale for {@link relevanceTier}; persisted to its own
   * `ImpactAffectedTable.relevanceRationale` column (raw material for the #932 BA
   * summary). No longer folded into `suggestedDdl` (OWASP LLM01 output handling).
   */
  relevanceRationale?: string;
}

/**
 * Epic #295 Phase 4 (#308) — resolves the canonical {@link SchemaObjectIdentity}
 * id for an affected object so cross-project impact can link to it. Injected
 * (optional) into {@link crossToSchema}; when absent, no identity linking
 * happens and behavior is byte-identical to Phase 1. Implementations reconcile
 * against a known DatabaseResource (see cross-project schema-object-identity
 * service). Returning null leaves the affected row unlinked.
 */
export type CrossProjectIdentityResolver = (object: {
  objectKind: UsageObjectKind;
  /** Schema-qualified table identity (`<schema>.<table>` or bare `<table>`). */
  tableName: string;
  columnName: string | null;
}) => Promise<string | null>;

/** Split a schema-qualified table name into its `schema` + `table` parts. */
function splitTableQn(qn: string): { schema?: string; table: string } {
  const i = qn.indexOf(".");
  if (i === -1) return { table: qn };
  return { schema: qn.slice(0, i), table: qn.slice(i + 1) };
}

/**
 * #923 — an *additive* column intent parsed from a requirement's natural-language
 * text (e.g. "add a status flag to account"). Drives a TEXT-ONLY `ADD COLUMN`
 * suggestion for source-only projects that have no live schema to diff against.
 * All fields are SUGGESTIONS: `columnName` is a sanitized `[a-z0-9_]` identifier,
 * `columnType` is a best-effort SQL type or `null` (⇒ a `<type>` placeholder when
 * the NL is ambiguous), and `entity` is the target-entity token used to match the
 * impacted table. `confidence` is `medium` when a type was inferred, else `low`.
 */
export interface AdditiveColumnIntent {
  columnName: string;
  columnType: string | null;
  entity: string | null;
  confidence: "low" | "medium";
}

/** Descriptor nouns that follow a field name ("status **flag**", "created **column**"). */
const FIELD_DESCRIPTOR = "flag|column|field|attribute|property|boolean|value";

/**
 * Sanitize an arbitrary NL token into a bare SQL identifier: camelCase and
 * (exported since #1001 — the LLM additive-column proposer sanitizes the model's
 * proposed column names through this SAME function, so both the deterministic
 * and the LLM path emit identical, metacharacter-free identifiers)
 * hyphens/spaces → snake_case, then strip everything outside `[a-z0-9_]`. Returns
 * `""` when nothing usable remains. Because the result is `[a-z0-9_]`-only, no SQL
 * metacharacter from the (untrusted) requirement text can survive into the
 * suggested — and never executed — DDL string.
 */
export function toSnakeIdentifier(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Best-effort SQL type from a descriptor + inferred column name; null ⇒ placeholder. */
function inferColumnType(columnName: string, descriptor: string | null): string | null {
  const d = descriptor?.toLowerCase() ?? "";
  if (
    d === "flag" ||
    d === "boolean" ||
    /^(is|has|can|should)_|_flag$|_enabled$/.test(columnName)
  ) {
    return "BOOLEAN";
  }
  if (/(^|_)(at|on|date|time|timestamp)$|(^|_)(date|time|timestamp)(_|$)/.test(columnName)) {
    return "TIMESTAMP";
  }
  if (/(^|_)(count|num|number|amount|qty|quantity|total)$/.test(columnName)) return "INTEGER";
  return null;
}

/**
 * Detect an *additive* (add-a-column) intent in a requirement's title/body text.
 * Two conservative forms, tried in order:
 *   1. `add|introduce|create|include [a|an|the] <field...> <descriptor> to|on|for|in [the] <entity>`
 *      — a descriptor noun (flag/column/field/…) makes this a high-precision match.
 *   2. `add|introduce [a|an|the] <field> to|onto [the] <entity>` — descriptor-less,
 *      restricted to directional add verbs so "create a report for admins" is ignored.
 * Returns null when no additive intent is present or the field reduces to a bare
 * descriptor with no real column name. Pure — no I/O.
 */
export function detectAdditiveColumnIntent(
  text: string | null | undefined,
): AdditiveColumnIntent | null {
  if (!text) return null;

  const withDescriptor = new RegExp(
    `\\b(?:add|introduce|create|include)\\s+(?:a|an|the)\\s+([A-Za-z][\\w-]*(?:\\s+[A-Za-z][\\w-]*){0,2}?)\\s+(${FIELD_DESCRIPTOR})\\s+(?:to|on|onto|for|in)\\s+(?:the\\s+)?([A-Za-z][\\w-]*)\\b`,
    "i",
  );
  const descriptorLess = new RegExp(
    `\\b(?:add|introduce)\\s+(?:a|an|the\\s+)?([A-Za-z][\\w-]*)\\s+(?:to|onto)\\s+(?:the\\s+)?([A-Za-z][\\w-]*)\\b`,
    "i",
  );

  let fieldPhrase: string;
  let descriptor: string | null;
  let entityRaw: string;

  const m1 = text.match(withDescriptor);
  if (m1) {
    fieldPhrase = m1[1];
    descriptor = m1[2];
    entityRaw = m1[3];
  } else {
    const m2 = text.match(descriptorLess);
    if (!m2) return null;
    fieldPhrase = m2[1];
    descriptor = null;
    entityRaw = m2[2];
  }

  const columnName = toSnakeIdentifier(fieldPhrase);
  // Reject an empty or bare-descriptor field name ("add a column to account").
  if (!columnName || new RegExp(`^(?:${FIELD_DESCRIPTOR})$`, "i").test(columnName)) return null;

  const entity = toSnakeIdentifier(entityRaw) || null;
  const columnType = inferColumnType(columnName, descriptor);
  return {
    columnName,
    columnType,
    entity,
    confidence: columnType ? "medium" : "low",
  };
}

/** Normalize an identifier for entity↔table matching: lowercased, non-alphanumeric stripped. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Naive singularization for plural/singular entity↔table matching (users ↔ user). */
function singularize(s: string): string {
  return s.length > 1 && s.endsWith("s") ? s.slice(0, -1) : s;
}

/**
 * Whether an additive intent's target `entity` refers to the impacted `table`.
 * Requires a parsed entity and matches on normalized equality (with simple
 * singular/plural folding) — deliberately strict so an additive suggestion only
 * attaches to the table the requirement actually names, never to every impacted
 * table in the blast radius.
 */
function entityMatchesTable(entity: string | null, table: string): boolean {
  if (!entity) return false;
  const e = normalizeForMatch(entity);
  const t = normalizeForMatch(table);
  if (!e || !t) return false;
  return e === t || singularize(e) === singularize(t);
}

/**
 * Build a syntactically-plausible DDL suggestion for one affected table/column.
 * **Returns TEXT ONLY — the engine never executes any DDL.** The reconciliation
 * status (vs the live schema) drives the suggested change kind.
 */
export function suggestDdl(input: {
  tableName: string;
  columnName: string | null;
  reconciliation: SchemaReconciliation | null;
  columnType: string | null;
  /**
   * #923 — an additive-column intent parsed from the requirement text, supplied
   * ONLY for the matched TABLE row when there is no live reconciliation. When
   * present it yields a clearly-marked, TEXT-ONLY `ADD COLUMN` suggestion so
   * source-only projects get an actionable additive suggestion. It NEVER overrides
   * the live-DB reconciliation path (which sets a non-null `reconciliation`).
   */
  additive?: AdditiveColumnIntent | null;
}): { changeKind: DdlChangeKind; suggestedDdl: string } {
  const { tableName, columnName, reconciliation, columnType, additive } = input;

  if (reconciliation === "table-not-found") {
    return {
      changeKind: "add-table",
      suggestedDdl: `-- CREATE TABLE ${tableName} ( ... ); -- referenced by impacted code but absent from live schema`,
    };
  }
  if (reconciliation === "column-not-found" && columnName) {
    return {
      changeKind: "add-column",
      suggestedDdl: `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType ?? "<type>"};`,
    };
  }
  // #923 — additive intent from requirement text (no live schema to diff). Only
  // for the matched TABLE row (columnName === null) with no reconciliation, so
  // the live-DB paths above are untouched.
  if (additive && reconciliation === null && !columnName) {
    return {
      changeKind: "add-column",
      suggestedDdl: `ALTER TABLE ${tableName} ADD COLUMN ${additive.columnName} ${additive.columnType ?? "<type>"}; -- SUGGESTED: add-column intent inferred from requirement text (column name/type are suggestions — verify)`,
    };
  }
  return { changeKind: "reference", suggestedDdl: verifyOnlyDdl(tableName, columnName) };
}

/**
 * The VERIFY-ONLY "DDL" for a row that proposes no schema change: a comment that
 * restates the identifiers already on the row. It carries no information beyond
 * `tableName`/`columnName`, which is why #1028's summarizer prompt collapses these
 * rows to one line per table. Exported so that collapse can recognise the string
 * EXACTLY rather than infer it from `changeKind` — a row whose DDL is anything
 * else is still rendered verbatim, so the collapse cannot drop a real suggestion
 * even if a future caller pairs `changeKind:"reference"` with substantive DDL.
 */
export function verifyOnlyDdl(tableName: string, columnName: string | null): string {
  return columnName
    ? `-- Verify column ${tableName}.${columnName} — referenced by impacted code`
    : `-- Verify table ${tableName} — referenced by impacted code`;
}

/** Confidence for an affected-table row, blending provenance with reconciliation. */
function affectedConfidence(
  source: SchemaSource,
  reconciliation: SchemaReconciliation | null,
): number {
  if (reconciliation === "table-not-found" || reconciliation === "column-not-found") return 0.4;
  if (isLiveSchemaSource(source)) return 0.95;
  if (reconciliation === "matched") return 0.85;
  return 0.6;
}

/**
 * #922 — upper bound on the confidence of a DAO/mapper *sibling-derived* affected
 * row. Sibling tables (surfaced because a sibling method of the impacted mapper
 * touches them, not the impacted method itself) are a recall aid, so they are
 * always LESS confident than any directly-crossed row. Kept in the issue's
 * suggested 0.4–0.5 band.
 */
const SIBLING_CONFIDENCE_CAP = 0.45;

/** Confidence for a sibling-derived row: the direct blend, capped so it can never rival a direct row. */
function siblingConfidence(
  source: SchemaSource,
  reconciliation: SchemaReconciliation | null,
): number {
  return Math.min(affectedConfidence(source, reconciliation), SIBLING_CONFIDENCE_CAP);
}

/**
 * #923 — confidence for a row whose DDL comes from an additive-intent suggestion
 * (no live schema). Held in the low/medium band because the name/type were
 * inferred from prose: `medium` (a type was inferred) ⇒ 0.5, `low` ⇒ 0.4.
 */
function additiveConfidence(confidence: "low" | "medium"): number {
  return confidence === "medium" ? 0.5 : 0.4;
}

/**
 * The enclosing type of a fully-qualified symbol name — everything up to the
 * last `.`. `org.jpetstore.mapper.AccountMapper.updateProfile` →
 * `org.jpetstore.mapper.AccountMapper`. Returns null when there is no `.` (a
 * top-level symbol has no enclosing type to expand from).
 */
function enclosingTypeOf(qualifiedName: string): string | null {
  const i = qualifiedName.lastIndexOf(".");
  if (i <= 0) return null;
  return qualifiedName.slice(0, i);
}

/**
 * The simple (unqualified) name of an enclosing type — its last dotted segment.
 * `org.jpetstore.mapper.AccountMapper` → `AccountMapper`.
 */
function simpleName(qualifiedName: string): string {
  const i = qualifiedName.lastIndexOf(".");
  return i === -1 ? qualifiedName : qualifiedName.slice(i + 1);
}

/**
 * Conservative recogniser for a DAO/mapper enclosing type. Matches the common
 * data-access naming conventions — MyBatis mappers (`*Mapper`), classic DAOs
 * (`*Dao`/`*DAO`), and Spring-Data / JPA repositories (`*Repository`/`*Repo`).
 * Deliberately name-based to keep sibling expansion PRECISE: a non-DAO enclosing
 * type never expands, so ordinary service/util methods are unaffected.
 */
function isDaoLikeEnclosingType(enclosingTypeQn: string): boolean {
  return /(?:Mapper|Dao|DAO|Repository|Repo)$/.test(simpleName(enclosingTypeQn));
}

/**
 * #928 — default maximum number of downstream `calls`/`executes` hops the schema
 * crossing walks from an impacted symbol to reach the data-access layer. The
 * canonical chain `service → (calls) → mapper method → (executes) → statement`
 * is 2 hops, so a cap of 2 reaches the data layer through ONE application layer
 * (service → mapper → statement) and stops there.
 *
 * #942 FIX 2 — lowered from 3 → 2 to DAMPEN TANGENTIAL FAN-OUT. Depth 3 let a far
 * web-action/controller (2 layers above the data access) fan out over `calls`
 * edges into MANY unrelated mappers → many wrong tables (e.g. a cart action for an
 * "add a status flag to account" requirement reaching `ItemMapper.getInventoryQuantity`
 * → `inventory`). A directly-seeded mapper (its table at depth 1) and the #928
 * near crossing (a service one layer up, depth 2) both still surface — the recall
 * win is preserved — while the deep tangential 3rd hop drops out. Callers can still
 * request a deeper walk explicitly via {@link CrossToSchemaOptions.maxDownstreamDepth}.
 */
export const DEFAULT_MAX_DOWNSTREAM_DEPTH = 2;

/**
 * #942 FIX 1 — confidence assigned to a schema symbol (`table`/`column`/routine)
 * that is ITSELF in the impacted blast radius (matched directly, not merely reached
 * via the downstream code→mapper walk). A direct hit is the strongest possible
 * signal — the requirement change touches the schema object by name — so it is
 * surfaced at HIGH confidence, above any decayed downstream ({@link DOWNSTREAM_DATA_LAYER_DECAY})
 * or sibling ({@link SIBLING_CONFIDENCE_CAP}) row for the same object. Matches the
 * live-schema tier (0.95) so a direct hit is treated as reliably as a reconciled row.
 */
export const DIRECT_SCHEMA_HIT_CONFIDENCE = 0.95;

/**
 * #928 — per-hop confidence multiplier for a table reached via the downstream
 * data-layer walk. A table directly owned by an impacted symbol (depth 0) keeps
 * full confidence; each additional `calls`/`executes` hop scales it by this
 * factor so a distantly-reached table always ranks below a close one.
 */
export const DOWNSTREAM_DATA_LAYER_DECAY = 0.8;

/**
 * #928 — walk DOWNSTREAM from `seedIds` over `calls`/`executes` edges (bounded by
 * `maxDepth`) and return every reachable symbol id mapped to the minimum hop
 * depth at which it was reached (seeds themselves at depth 0). This pulls the
 * data-access layer — mapper/DAO methods AND the MyBatis statement symbols they
 * `executes` — into the crossing set so {@link crossToSchema} can follow those
 * statements' `reads`/`writes`/`persists-to` edges to real tables, even though
 * the code-impact blast radius intentionally stayed upstream (callers).
 *
 * Read-only. A no-op that returns just the seeds (depth 0) when the data source
 * lacks {@link SchemaImpactDataSource.getDownstreamCallEdgesFrom} — preserving
 * the pre-#928 single-hop crossing for callers/tests that don't wire it.
 */
async function resolveDownstreamDataLayer(
  seedIds: string[],
  dataSource: SchemaImpactDataSource,
  maxDepth: number,
): Promise<Map<string, number>> {
  const depthById = new Map<string, number>();
  for (const id of seedIds) depthById.set(id, 0);
  if (!dataSource.getDownstreamCallEdgesFrom || maxDepth <= 0 || depthById.size === 0) {
    return depthById;
  }
  let frontier = [...depthById.keys()];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const edges = await dataSource.getDownstreamCallEdgesFrom(frontier);
    const next: string[] = [];
    for (const e of edges) {
      if (!e.toSymbolId || depthById.has(e.toSymbolId)) continue;
      depthById.set(e.toSymbolId, depth + 1);
      next.push(e.toSymbolId);
    }
    frontier = next;
  }
  return depthById;
}

/** #922 — options controlling the schema crossing. */
export interface CrossToSchemaOptions {
  /**
   * #928 — maximum downstream `calls`/`executes` hops to walk from each impacted
   * symbol into the data-access layer. Defaults to {@link DEFAULT_MAX_DOWNSTREAM_DEPTH}.
   * Set to 0 to disable the downstream walk entirely (pre-#928 single-hop crossing).
   */
  maxDownstreamDepth?: number;
  /**
   * When true, an impacted symbol that is a method of a mapper/DAO enclosing type
   * (e.g. a MyBatis mapper namespace or a JPA repository) expands the crossing to
   * the *sibling* methods of that same type, so the DAO's full table footprint is
   * reflected. Sibling-derived tables are surfaced at reduced confidence
   * ({@link SIBLING_CONFIDENCE_CAP}) and marked `siblingDerived`, and NEVER
   * override a directly-crossed row. Requires the data source to implement
   * {@link SchemaImpactDataSource.getCodeSymbolsByIds} and
   * {@link SchemaImpactDataSource.getSiblingMethodIds}; a no-op otherwise.
   * Default false — behaviour is byte-identical to before #922.
   */
  expandDaoSiblings?: boolean;
  /**
   * #923 — the requirement's natural-language text (title + body). When it
   * expresses an *additive* intent ("add a status flag to account"), the matched
   * TABLE row is upgraded from a verify-comment to a TEXT-ONLY `ADD COLUMN`
   * suggestion — even with no live schema — via {@link detectAdditiveColumnIntent}.
   * Omitted/blank ⇒ behaviour is byte-identical to before #923.
   */
  requirementText?: string | null;
}

/**
 * Turn one schema symbol reached from impacted code into an affected row.
 * `sibling` marks a row surfaced only via DAO/mapper sibling expansion (#922),
 * which lowers its confidence and sets {@link AffectedTableInput.siblingDerived}.
 * `additive` (#923) is the requirement-text additive intent; it upgrades a
 * matched TABLE row's verify-comment to a TEXT-ONLY `ADD COLUMN` suggestion when
 * there is no live schema (see {@link entityMatchesTable}). Returns the dedupe
 * `key` alongside the row. Pure — no I/O.
 */
function buildAffectedRow(
  sym: SchemaSymbolRow,
  liveIndex: LiveSchemaIndex | null | undefined,
  sibling: boolean,
  additive?: AdditiveColumnIntent | null,
  /**
   * #928 — multiplier (0–1) applied to the row's confidence, decaying it by how
   * many downstream `calls`/`executes` hops separated the impacted seed from the
   * schema-edge owner. 1 for a directly-owned edge (depth 0). Never widens
   * confidence (always ≤ the un-decayed value).
   */
  confidenceScale = 1,
  /**
   * #942 FIX 1 — when true, this row was surfaced because the schema symbol is
   * ITSELF in the blast radius (a direct hit), so its confidence is pinned to
   * {@link DIRECT_SCHEMA_HIT_CONFIDENCE} (HIGH), overriding the decayed/blended
   * value. The reconciliation + suggested-DDL logic is unchanged.
   */
  directHit = false,
): { key: string; row: AffectedTableInput } {
  // Epic #293 Phase 2 (#302) — a routine (procedure/function) reached via an
  // `executes` edge surfaces as an affected object. METIS NEVER suggests
  // dropping/altering a routine here (its body is not analyzed until Phase 3),
  // so the "DDL" is a verify-only note and the changeKind is `reference`.
  if (sym.kind === "procedure" || sym.kind === "function") {
    const routineQn = sym.qualifiedName;
    const rSource: SchemaSource = sym.source ?? "live-db";
    return {
      key: `${sym.kind} ${routineQn}`,
      row: {
        objectKind: sym.kind,
        tableName: routineQn,
        columnName: null,
        columnType: null,
        changeKind: "reference",
        suggestedDdl: `-- Verify ${sym.kind} ${routineQn} — invoked by impacted code (body not analyzed; Phase 3)`,
        source: rSource,
        reconciliation: null,
        confidence: directHit
          ? DIRECT_SCHEMA_HIT_CONFIDENCE
          : (sibling ? siblingConfidence(rSource, null) : affectedConfidence(rSource, null)) *
            confidenceScale,
        siblingDerived: sibling || undefined,
      },
    };
  }

  let tableQn: string;
  let columnName: string | null;
  if (sym.kind === "column") {
    // qualifiedName === `${tableQn}.${name}` — strip the trailing column.
    tableQn = sym.qualifiedName.slice(0, -(sym.name.length + 1)) || sym.qualifiedName;
    columnName = sym.name;
  } else {
    tableQn = sym.qualifiedName;
    columnName = null;
  }

  const { schema, table } = splitTableQn(tableQn);
  const source: SchemaSource = sym.source ?? "mybatis";

  const reconciliation: SchemaReconciliation | null = liveIndex
    ? liveIndex.reconcile({ table, schema, column: columnName })
    : null;

  const columnType =
    columnName && liveIndex
      ? (liveIndex.getColumn(table, columnName, schema)?.dataType ?? null)
      : null;

  // #923 — an additive suggestion applies only to the matched TABLE row this
  // requirement names, with no live reconciliation, and never via a sibling row
  // (siblings are a recall aid, not the named entity). When it applies we hand the
  // intent to suggestDdl; otherwise the existing reference/verify behavior stands.
  const additiveApplies =
    !sibling &&
    !!additive &&
    reconciliation === null &&
    columnName === null &&
    entityMatchesTable(additive.entity, table);

  const { changeKind, suggestedDdl } = suggestDdl({
    tableName: tableQn,
    columnName,
    reconciliation,
    columnType,
    additive: additiveApplies ? additive : null,
  });

  const confidence = directHit
    ? DIRECT_SCHEMA_HIT_CONFIDENCE
    : (additiveApplies
        ? additiveConfidence(additive!.confidence)
        : sibling
          ? siblingConfidence(source, reconciliation)
          : affectedConfidence(source, reconciliation)) * confidenceScale;

  return {
    key: `${tableQn}\u0000${columnName ?? ""}`,
    row: {
      objectKind: columnName ? "column" : "table",
      tableName: tableQn,
      columnName,
      columnType,
      changeKind,
      suggestedDdl: sibling
        ? `${suggestedDdl} [surfaced via a sibling method of the same DAO/mapper — reduced confidence]`
        : suggestedDdl,
      source,
      reconciliation,
      confidence,
      siblingDerived: sibling || undefined,
    },
  };
}

/**
 * Resolve the sibling-method symbol ids to expand into (#922). Reads the seed
 * symbols, keeps only mapper/DAO methods, then asks the data source for the
 * other methods of each such enclosing type — excluding the seeds themselves.
 * Returns [] (and does no work) when the option is off or the data source lacks
 * the optional sibling hooks, so the READ-ONLY crossing is never widened
 * unexpectedly.
 */
async function resolveDaoSiblingIds(
  seedIds: string[],
  dataSource: SchemaImpactDataSource,
): Promise<string[]> {
  if (!dataSource.getCodeSymbolsByIds || !dataSource.getSiblingMethodIds) return [];

  const seedSymbols = await dataSource.getCodeSymbolsByIds(seedIds);
  const seedSet = new Set(seedIds);
  const enclosingTypes = new Set<string>();
  for (const sym of seedSymbols) {
    if (sym.kind !== "method") continue;
    const enclosing = enclosingTypeOf(sym.qualifiedName);
    if (enclosing && isDaoLikeEnclosingType(enclosing)) enclosingTypes.add(enclosing);
  }
  if (enclosingTypes.size === 0) return [];

  const siblings = await dataSource.getSiblingMethodIds([...enclosingTypes]);
  return [...new Set(siblings.map((s) => s.id).filter((id) => id && !seedSet.has(id)))];
}

/**
 * Cross a set of impacted code symbols into the schema graph, returning the
 * affected (table, column?) rows with reconciliation + suggested DDL. Deduped
 * by `(tableName, columnName)`; the highest-confidence row wins.
 *
 * When {@link CrossToSchemaOptions.expandDaoSiblings} is set, a directly impacted
 * mapper/DAO method additionally surfaces the tables touched by its SIBLING
 * methods, at reduced confidence and marked `siblingDerived` — recall for the
 * DAO's full footprint without demoting any directly-crossed table (#922).
 */
export async function crossToSchema(
  affectedSymbolIds: string[],
  dataSource: SchemaImpactDataSource,
  liveIndex?: LiveSchemaIndex | null,
  /**
   * Epic #295 Phase 4 (#308) — optional canonical-identity resolver. When
   * provided, each affected row is associated with its cross-project
   * {@link SchemaObjectIdentity}. Omitted by the common single-project path, so
   * behavior is unchanged when there is no workspace/resource context.
   */
  identityResolver?: CrossProjectIdentityResolver | null,
  options?: CrossToSchemaOptions | null,
): Promise<AffectedTableInput[]> {
  const seedIds = affectedSymbolIds.filter(Boolean);
  if (seedIds.length === 0) return [];

  // #923 — parse the requirement's additive intent ONCE; buildAffectedRow attaches
  // it only to the matched table row (entity match + no live reconciliation).
  const additive = detectAdditiveColumnIntent(options?.requirementText);

  const byKey = new Map<string, AffectedTableInput>();
  // Keys crossed by a DIRECTLY impacted symbol (a direct schema hit, #942, or a
  // directly-owned reads/writes edge, #928) — these always win over siblings.
  const directKeys = new Set<string>();

  // #942 FIX 1 — a schema symbol (table/column/routine) that is ITSELF in the blast
  // radius (matched directly, not only reached via the downstream code→mapper walk)
  // is the strongest signal, so surface it — and, for a column, its parent table —
  // at HIGH confidence. Without this a requirement that directly hits `account.status`
  // would leave the `account` table unsurfaced (columns own no outgoing schema edge),
  // while a decayed downstream fan-out could surface the wrong table instead.
  const directSchemaSeeds = await dataSource.getSchemaSymbolsByIds(seedIds);
  for (const sym of directSchemaSeeds) {
    const { key, row } = buildAffectedRow(sym, liveIndex, false, additive, 1, true);
    directKeys.add(key);
    byKey.set(key, row);
    if (sym.kind === "column") {
      // Promote the parent TABLE of a directly-hit column (`account.status` → `account`).
      const tableQn = sym.qualifiedName.slice(0, -(sym.name.length + 1)) || sym.qualifiedName;
      const tableSym: SchemaSymbolRow = {
        id: `${sym.id}:parent-table`,
        kind: "table",
        name: splitTableQn(tableQn).table,
        qualifiedName: tableQn,
        source: sym.source,
      };
      const { key: tKey, row: tRow } = buildAffectedRow(
        tableSym,
        liveIndex,
        false,
        additive,
        1,
        true,
      );
      if (!byKey.has(tKey)) {
        directKeys.add(tKey);
        byKey.set(tKey, tRow);
      }
    }
  }

  // #928 — expand the impacted set DOWNSTREAM into the data-access layer so a
  // mapper/DAO method and its MyBatis statement symbol enter the crossing set
  // even when the (upstream) code-impact radius never reached them. `depthById`
  // maps every reachable symbol to its hop distance for confidence decay; the
  // `executes` edge into a statement symbol is a transparent pass-through — the
  // statement joins the reachable set and its `reads`/`writes` are crossed below,
  // while the statement itself (kind=`method`) is dropped by the schema-symbol
  // filter and never surfaced as a terminal object.
  const maxDownstreamDepth = options?.maxDownstreamDepth ?? DEFAULT_MAX_DOWNSTREAM_DEPTH;
  const directDepthById = await resolveDownstreamDataLayer(seedIds, dataSource, maxDownstreamDepth);
  const edges = await dataSource.getSchemaEdgesFrom([...directDepthById.keys()]);

  // #922 — DAO/mapper sibling expansion (opt-in). Resolve the sibling method ids,
  // expand THEM downstream too (so a sibling MyBatis mapper method reaches its
  // statement's tables), and fetch their schema edges separately so we can tag
  // the resulting rows as sibling-derived (reduced confidence) without touching
  // the direct rows. Symbols already reached directly are removed so a table
  // never loses its higher direct confidence to a sibling row.
  const siblingSeedIds = options?.expandDaoSiblings
    ? await resolveDaoSiblingIds(seedIds, dataSource)
    : [];
  const siblingDepthById =
    siblingSeedIds.length > 0
      ? await resolveDownstreamDataLayer(siblingSeedIds, dataSource, maxDownstreamDepth)
      : new Map<string, number>();
  for (const id of directDepthById.keys()) siblingDepthById.delete(id);
  const siblingEdges =
    siblingDepthById.size > 0
      ? await dataSource.getSchemaEdgesFrom([...siblingDepthById.keys()])
      : [];

  // Nothing to cross unless an edge was found OR a direct schema hit (#942) already
  // populated a row.
  if (edges.length === 0 && siblingEdges.length === 0 && byKey.size === 0) return [];

  const targetIds = [
    ...new Set([...edges, ...siblingEdges].map((e) => e.toSymbolId).filter(Boolean)),
  ];
  const symbols = await dataSource.getSchemaSymbolsByIds(targetIds);
  const symbolById = new Map(symbols.map((s) => [s.id, s]));

  for (const edge of edges) {
    const sym = symbolById.get(edge.toSymbolId);
    if (!sym) continue;
    // #928 — decay confidence by how far downstream the edge's OWNER was reached.
    const scale = Math.pow(
      DOWNSTREAM_DATA_LAYER_DECAY,
      directDepthById.get(edge.fromSymbolId) ?? 0,
    );
    const { key, row } = buildAffectedRow(sym, liveIndex, false, additive, scale);
    directKeys.add(key);
    const existing = byKey.get(key);
    if (!existing || row.confidence > existing.confidence) byKey.set(key, row);
  }

  // Sibling rows are added ONLY where no direct row exists, so a table crossed
  // directly keeps its higher confidence and precision is not regressed.
  for (const edge of siblingEdges) {
    const sym = symbolById.get(edge.toSymbolId);
    if (!sym) continue;
    const scale = Math.pow(
      DOWNSTREAM_DATA_LAYER_DECAY,
      siblingDepthById.get(edge.fromSymbolId) ?? 0,
    );
    const { key, row } = buildAffectedRow(sym, liveIndex, true, null, scale);
    if (directKeys.has(key)) continue;
    const existing = byKey.get(key);
    if (!existing || row.confidence > existing.confidence) byKey.set(key, row);
  }

  const rows = [...byKey.values()].sort(
    (a, b) =>
      a.tableName.localeCompare(b.tableName) ||
      (a.columnName ?? "").localeCompare(b.columnName ?? ""),
  );

  // Epic #295 Phase 4 (#308) — associate each affected row with its canonical
  // cross-project identity when a resolver is supplied. Best-effort: a null
  // resolution (object not in the registry) leaves the row unlinked. Done after
  // dedupe so we resolve once per distinct object, not per edge.
  if (identityResolver) {
    for (const row of rows) {
      row.schemaObjectIdentityId = await identityResolver({
        objectKind: row.objectKind,
        tableName: row.tableName,
        columnName: row.columnName,
      });
    }
  }

  return rows;
}

/** Maximum number of IDs to pass in a single `IN (...)` clause (SQLite limit). */
const IN_CHUNK_SIZE = 500;

/**
 * Split an array into chunks of at most `size` elements, call `fn` on each
 * chunk, and return the concatenated results. Keeps each DB round-trip well
 * within the parameter limit regardless of input size.
 */
async function chunkedIn<T>(ids: string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
    const batch = ids.slice(i, i + IN_CHUNK_SIZE);
    results.push(...(await fn(batch)));
  }
  return results;
}

/** A `SchemaImpactDataSource` scoped to one project, backed by Prisma. */
export class PrismaSchemaImpactDataSource implements SchemaImpactDataSource {
  constructor(
    private readonly prisma: Pick<PrismaClient, "codeSymbol" | "codeEdge">,
    private readonly projectId: string,
  ) {}

  async getSchemaEdgesFrom(symbolIds: string[]): Promise<SchemaEdgeRow[]> {
    if (symbolIds.length === 0) return [];
    const rows = await chunkedIn(symbolIds, (chunk) =>
      this.prisma.codeEdge.findMany({
        where: {
          projectId: this.projectId,
          fromSymbolId: { in: chunk },
          kind: { in: [...SCHEMA_IMPACT_EDGE_KINDS] },
          toSymbolId: { not: null },
        },
        select: { fromSymbolId: true, toSymbolId: true, kind: true },
      }),
    );
    return rows.map((e) => ({
      fromSymbolId: e.fromSymbolId,
      toSymbolId: e.toSymbolId as string,
      kind: e.kind as SchemaEdgeKind,
    }));
  }

  /**
   * #928 — downstream `calls`/`executes` edges out of the given symbols, project-
   * scoped and read-only. Drives the data-layer reachability walk in
   * {@link crossToSchema}: `calls` steps from a caller into a mapper/DAO method,
   * `executes` steps from that method into its MyBatis statement symbol.
   */
  async getDownstreamCallEdgesFrom(symbolIds: string[]): Promise<DownstreamCodeEdgeRow[]> {
    if (symbolIds.length === 0) return [];
    const rows = await chunkedIn(symbolIds, (chunk) =>
      this.prisma.codeEdge.findMany({
        where: {
          projectId: this.projectId,
          fromSymbolId: { in: chunk },
          kind: { in: [...DOWNSTREAM_CALL_EDGE_KINDS] },
          toSymbolId: { not: null },
        },
        select: { fromSymbolId: true, toSymbolId: true },
      }),
    );
    return rows.map((e) => ({ fromSymbolId: e.fromSymbolId, toSymbolId: e.toSymbolId as string }));
  }

  async getSchemaSymbolsByIds(ids: string[]): Promise<SchemaSymbolRow[]> {
    if (ids.length === 0) return [];
    const rows = await chunkedIn(ids, (chunk) =>
      this.prisma.codeSymbol.findMany({
        where: {
          id: { in: chunk },
          projectId: this.projectId,
          kind: { in: ["table", "column", "procedure", "function"] },
        },
        select: { id: true, kind: true, name: true, qualifiedName: true, source: true },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as SchemaSymbolRow["kind"],
      name: r.name,
      qualifiedName: r.qualifiedName,
      source: r.source as SchemaSource | null,
    }));
  }

  /**
   * #922 — resolve code-symbol identities for DAO/mapper sibling expansion.
   * Read-only, project-scoped. Any kind is returned (the pure caller filters to
   * `method`).
   */
  async getCodeSymbolsByIds(ids: string[]): Promise<CodeSymbolIdentity[]> {
    if (ids.length === 0) return [];
    const rows = await chunkedIn(ids, (chunk) =>
      this.prisma.codeSymbol.findMany({
        where: { id: { in: chunk }, projectId: this.projectId },
        select: { id: true, kind: true, qualifiedName: true },
      }),
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, qualifiedName: r.qualifiedName }));
  }

  /**
   * #922 — the `method` symbols whose enclosing type (qualifiedName up to the
   * last `.`) is one of `enclosingTypes`. A prefix `startsWith` narrows the query
   * in the DB (parameterised — no injection); the exact enclosing match is
   * re-checked in JS so `AccountMapper` never leaks siblings of
   * `AccountMapperExtra` and nested `Outer.Inner.m` methods are excluded.
   */
  async getSiblingMethodIds(enclosingTypes: string[]): Promise<CodeSymbolIdentity[]> {
    if (enclosingTypes.length === 0) return [];
    const wanted = new Set(enclosingTypes);
    const rows = await chunkedIn(enclosingTypes, (chunk) =>
      this.prisma.codeSymbol.findMany({
        where: {
          projectId: this.projectId,
          kind: "method",
          OR: chunk.map((enclosing) => ({ qualifiedName: { startsWith: `${enclosing}.` } })),
        },
        select: { id: true, kind: true, qualifiedName: true },
      }),
    );
    return rows
      .map((r) => ({ id: r.id, kind: r.kind, qualifiedName: r.qualifiedName }))
      .filter((r) => {
        const i = r.qualifiedName.lastIndexOf(".");
        return i > 0 && wanted.has(r.qualifiedName.slice(0, i));
      });
  }
}
