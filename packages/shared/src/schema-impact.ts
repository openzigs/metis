/**
 * Database schema / DDL impact analysis — Epic #168 (extends #159).
 *
 * Adds a *schema* dimension to the multi-project impact engine: a requirement
 * change can imply a data change, so METIS reports the affected database
 * tables/columns per project plus the suggested DDL (TEXT ONLY — never
 * executed).
 *
 * Two schema-symbol kinds (`table`, `column`) and three schema-edge kinds
 * (`reads`, `writes`, `persists-to`) extend the code graph (#169). Provenance
 * (`source`) records where a symbol/mapping came from:
 *   - `live-db`   — introspected from a live `DatabaseConnection` (ground truth)
 *   - `mybatis`   — inferred from MyBatis XML mappers / annotations (#170)
 *   - `orm`       — inferred from JPA/Hibernate or Prisma models (#171)
 *   - `ddl-file`  — parsed from a `.sql`/DDL file in the repo (#172)
 */
import { z } from "zod";
import { idSchema } from "./common.js";

// ---- Constants -------------------------------------------------------------

/**
 * `CodeSymbol.kind` values for the schema graph.
 *   - `table` / `column` — relational objects (Epic #168).
 *   - `procedure` / `function` — stored routines (Epic #293 Phase 2, #301),
 *     introspected by {@link DbRoutineInfo}. ADDITIVE: existing consumers that
 *     only care about table/column are unaffected.
 */
export const SCHEMA_SYMBOL_KINDS = ["table", "column", "procedure", "function"] as const;
export type SchemaSymbolKind = (typeof SCHEMA_SYMBOL_KINDS)[number];

/** Subset of {@link SCHEMA_SYMBOL_KINDS} that are stored routines (#301). */
export const SCHEMA_ROUTINE_KINDS = ["procedure", "function"] as const;
export type SchemaRoutineKind = (typeof SCHEMA_ROUTINE_KINDS)[number];

/**
 * `CodeEdge.kind` values for the schema graph.
 *   - `reads` / `writes` / `persists-to` — code/mapper/entity → table/column
 *     (Epic #168).
 *   - `executes` — code-invokes-routine: a code symbol → procedure/function
 *     (Epic #293 Phase 2, #301).
 *   - `calls` — routine-references-object: a procedure/function → the
 *     table/column (or routine) its body touches. Phase 2 records the EDGE KIND
 *     and wiring; deep body-level extraction that populates these is Phase 3
 *     (#294). ADDITIVE: existing reconciliation/source enums are unchanged.
 */
export const SCHEMA_EDGE_KINDS = ["reads", "writes", "persists-to", "executes", "calls"] as const;
export type SchemaEdgeKind = (typeof SCHEMA_EDGE_KINDS)[number];

/**
 * The schema-edge kinds whose target is a `table`/`column` object: the original
 * three (#168). Used by the table/column reconciliation + impact-crossing
 * queries so they keep their exact Phase 1 behavior and are NOT widened by the
 * new routine edge kinds (`executes`/`calls`). The routine pipeline (#301/#302)
 * selects {@link SCHEMA_ROUTINE_EDGE_KINDS} explicitly instead.
 */
export const SCHEMA_OBJECT_EDGE_KINDS = ["reads", "writes", "persists-to"] as const;
export type SchemaObjectEdgeKind = (typeof SCHEMA_OBJECT_EDGE_KINDS)[number];

/** The schema-edge kinds that involve a routine (procedure/function) — #301. */
export const SCHEMA_ROUTINE_EDGE_KINDS = ["executes", "calls"] as const;
export type SchemaRoutineEdgeKind = (typeof SCHEMA_ROUTINE_EDGE_KINDS)[number];

/**
 * The edge kinds the impact engine crosses from impacted CODE into the schema
 * graph — Epic #293 Phase 2 (#302): the table/column edges (#168) PLUS the
 * code→routine `executes` edge. The `calls` edge originates FROM a routine (its
 * body, Phase 3 / #294) and is intentionally excluded — it is not crossed from
 * code.
 */
export const SCHEMA_IMPACT_EDGE_KINDS = ["reads", "writes", "persists-to", "executes"] as const;
export type SchemaImpactEdgeKind = (typeof SCHEMA_IMPACT_EDGE_KINDS)[number];

/**
 * Kind of schema object a classification / affected-object entry applies to.
 * `table`/`column` (#168); `procedure`/`function` routines added in Epic #293
 * Phase 2 (#302). ADDITIVE — existing table/column consumers are unaffected.
 */
export const USAGE_OBJECT_KINDS = ["table", "column", "procedure", "function"] as const;
export type UsageObjectKind = (typeof USAGE_OBJECT_KINDS)[number];

/**
 * Provenance of a schema symbol / mapping. `live-db` is authoritative.
 *   - `live-db`/`mybatis`/`orm`/`ddl-file` — Epic #168.
 *   - `sqlglot` — parsed by the `metis-sql-lineage` sidecar from embedded SQL,
 *     procedure bodies, or SAS PROC SQL (Epic #294 Phase 3, #304/#305/#306).
 *   - `manual` — asserted/corrected by a human via the manual-override path
 *     (Epic #294 Phase 3, #304). Overrides take precedence over derived sources
 *     (see {@link SCHEMA_SOURCE_PRECEDENCE}). ADDITIVE — existing consumers that
 *     switch on the original four sources are unaffected.
 *   - `catalog-deps` — a **coarse, Tier-1** object→referenced-object edge read
 *     directly from a dialect's dependency catalog (Oracle
 *     `ALL_DEPENDENCIES`/`DBA_DEPENDENCIES`), zero-parse (Epic #881 Phase 1,
 *     #890). Object-level only — no column, no read/write direction, blind to
 *     dynamic SQL. Ranked BELOW `sqlglot` so Tier-2 body-parsed `calls` edges
 *     (#891-#893) refine/override it once available; ranked ABOVE the static
 *     file-inferred sources because it still comes from the live catalog.
 *     ADDITIVE — existing consumers are unaffected.
 *   - `jooq` — jOOQ generated table-class SYMBOL RESOLUTION (Epic #883, #897):
 *     a generated `TableImpl` class's self-registering constant is resolved to
 *     its physical table, and application `DSLContext` call sites (`.from(BOOK)`
 *     etc.) are mapped to `reads`/`writes` edges. No SQL string is parsed. Pure
 *     static file parsing like `mybatis`/`orm`/`ddl-file` — same precedence
 *     tier. ADDITIVE — existing consumers are unaffected.
 *   - `llm-recovery` — the #1029 column-informed table-relevance RECOVERY judge:
 *     a business-vocabulary requirement whose data maps to an UNSURFACED table's
 *     OWN columns (e.g. `account`'s address columns) is recovered at the
 *     `possible` tier. LLM-inferred, so it ranks BELOW every parsed/live source
 *     and is opt-in behind `IMPACT_LLM_TABLE_JUDGE`. ADDITIVE.
 */
export const SCHEMA_SOURCES = [
  "live-db",
  "mybatis",
  "orm",
  "ddl-file",
  "sqlglot",
  "manual",
  "catalog-deps",
  "jooq",
  "llm-recovery",
] as const;
export type SchemaSource = (typeof SCHEMA_SOURCES)[number];

/**
 * Precedence ranking for conflicting schema provenance — Epic #294 (#304).
 * Higher wins. A `manual` human assertion always beats a derived source; a
 * `live-db` introspection beats inferred mappers/parsers. Used to decide which
 * source's classification/edge takes effect when several point at one object.
 *
 * `catalog-deps` (Tier-1 coarse lineage, #890) sits BELOW `sqlglot` (Tier-2
 * body-parsed) so a precise body-derived edge always wins over the coarse
 * catalog fallback, and ABOVE the static file-inferred sources since it is
 * still read live from the database catalog.
 */
export const SCHEMA_SOURCE_PRECEDENCE: Record<SchemaSource, number> = {
  manual: 100,
  "live-db": 80,
  sqlglot: 60,
  "catalog-deps": 50,
  mybatis: 40,
  orm: 40,
  "ddl-file": 40,
  jooq: 40,
  "llm-recovery": 20,
};

/**
 * Reconciliation status of an inferred (mybatis/orm/ddl-file) ref against the
 * live schema. `null`/`matched` means it lines up with ground truth; the
 * `*-not-found` values flag a mapper/entity referencing something the live DB
 * does not have.
 */
export const SCHEMA_RECONCILIATIONS = ["matched", "table-not-found", "column-not-found"] as const;
export type SchemaReconciliation = (typeof SCHEMA_RECONCILIATIONS)[number];

/** Kind of DDL change suggested for an affected table/column. */
export const DDL_CHANGE_KINDS = [
  "add-table",
  "add-column",
  "alter-column",
  "drop-column",
  "reference",
] as const;
export type DdlChangeKind = (typeof DDL_CHANGE_KINDS)[number];

/**
 * Breaking-change classification for a suggested DDL change — Epic #820 Phase 3
 * (#830). The canonical `expand/contract` triage vocabulary shared by the gap
 * report, the schema-impact context rows, and (later) cross-project detection
 * (#831):
 *
 *   - `breaking`   — a *contract* operation that can break existing consumers:
 *                    a DROP (`drop-column`, a drop-table suggestion), a
 *                    type-narrowing / nullability-tightening `alter-column`, an
 *                    `add-column NOT NULL` without a default, or any change whose
 *                    before/after shape is UNKNOWN (conservative default).
 *   - `expanding`  — a safe *expand* operation, additive for existing consumers:
 *                    `add-table`, a nullable/defaulted `add-column`, or a
 *                    type-widening / nullability-relaxing `alter-column`.
 *   - `neutral`    — no structural change (`reference` / verify-only).
 *
 * The mapping is deterministic and LLM-free — see {@link classifyDdlRisk} in
 * `server/src/lib/impact-analysis/ddl-risk-classifier.ts`. It is purely advisory
 * triage over TEXT-ONLY suggestions and NEVER gates or triggers any execution.
 */
export const DDL_RISK_CLASSES = ["breaking", "expanding", "neutral"] as const;
export type DdlRiskClass = (typeof DDL_RISK_CLASSES)[number];

/** Zod validator for a {@link DdlRiskClass} (#830). */
export const ddlRiskClassSchema = z.enum(DDL_RISK_CLASSES);

/**
 * Issue #991 — single source of truth for the {@link DdlRiskClass} human
 * label. Previously duplicated as three parallel vocabularies that could
 * drift: the UI risk badge (`ui/src/components/impact/affected-tables-section.tsx`),
 * the impact-analysis markdown export, and the gap-report bullet renderer
 * (`server/src/lib/analysis/analysis-export.ts`) — the last of which leaked
 * the raw enum value instead of a human label. All three now import this map.
 */
export const DDL_RISK_LABEL: Record<DdlRiskClass, string> = {
  breaking: "Needs review",
  expanding: "Additive",
  neutral: "Verify only",
};

// ---- Schema symbol / edge --------------------------------------------------

/**
 * A persisted schema symbol (a `CodeSymbol` whose `kind` is `table` or
 * `column`). `qualifiedName` is the schema-qualified identity
 * (`<schema>.<table>` or `<schema>.<table>.<column>`).
 */
export const schemaSymbolSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  kind: z.enum(SCHEMA_SYMBOL_KINDS),
  name: z.string().min(1).max(256),
  qualifiedName: z.string().min(1).max(1024),
  source: z.enum(SCHEMA_SOURCES),
  /** Live column type when known (`source = live-db`), else null. */
  columnType: z.string().max(256).nullable().optional(),
});
export type SchemaSymbol = z.infer<typeof schemaSymbolSchema>;

/** A persisted schema edge (code/mapper/entity → table/column). */
export const schemaEdgeSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  kind: z.enum(SCHEMA_EDGE_KINDS),
  fromSymbolId: idSchema,
  toSymbolId: idSchema.nullable(),
  toQualifiedName: z.string().min(1).max(1024).nullable(),
  source: z.enum(SCHEMA_SOURCES),
});
export type SchemaEdge = z.infer<typeof schemaEdgeSchema>;

// ---- ImpactAffectedTable ---------------------------------------------------

/**
 * One affected (table, column?) entry attached to an `ImpactItem`. A row with
 * `columnName = null` is a table-level entry; column-level entries carry a
 * non-null `columnName`. `suggestedDdl` is a syntactically-plausible DDL string
 * derived from the requirement delta — **TEXT ONLY, never executed**.
 */
export const impactAffectedTableSchema = z.object({
  id: idSchema,
  impactItemId: idSchema,
  /** Object kind — `table`/`column` (#168) or `procedure`/`function` (#302). */
  objectKind: z.enum(USAGE_OBJECT_KINDS).default("table"),
  tableName: z.string().min(1).max(512),
  columnName: z.string().min(1).max(512).nullable(),
  columnType: z.string().max(256).nullable(),
  changeKind: z.enum(DDL_CHANGE_KINDS),
  suggestedDdl: z.string().max(8192).nullable(),
  source: z.enum(SCHEMA_SOURCES),
  reconciliation: z.enum(SCHEMA_RECONCILIATIONS).nullable(),
  confidence: z.number().min(0).max(1),
});
export type ImpactAffectedTable = z.infer<typeof impactAffectedTableSchema>;

// ---- Cross-project consumers (Epic #954 / #956) ----------------------------

/**
 * How a sibling project touches an affected shared table — Epic #954 (#956).
 * `readBy` when its only evidence is `reads`; `writtenBy` when ANY evidence
 * mutates the object (`writes`/`persists-to`). A write anywhere wins.
 */
export const IMPACT_CONSUMER_USAGES = ["readBy", "writtenBy"] as const;
export type ImpactConsumerUsage = (typeof IMPACT_CONSUMER_USAGES)[number];

/**
 * Per affected table, how the cross-project consumer set was resolved — Epic
 * #954 (#956). These are DISTINCT states so "no consumers" is never confused
 * with "could not verify" (preserving #822's could-not-verify semantics):
 *
 *   - `identity`     — the object's canonical cross-project identity resolved
 *     (the analyzed project's DB connection is linked to a shared
 *     {@link DatabaseResource} and the object exists in the identity registry).
 *     The consumer list is AUTHORITATIVE — an empty list means a verified "no
 *     other project uses this table".
 *   - `string-match` — identity was absent, so consumers were matched by bare
 *     `SchemaUsageClassification.tableName` across the workspace. LOWER
 *     CONFIDENCE (two projects may name unrelated physical tables identically);
 *     surfaced but clearly labelled. A non-empty list is a heuristic match.
 *   - `unverifiable` — identity was absent AND string-match found no positive
 *     evidence, so cross-project impact is UNKNOWN. Rendered as "could not
 *     verify", NEVER as "no consumers".
 *
 * A row with `consumerResolution` undefined/null was not computed (single-
 * project / no-workspace context) and renders exactly as before this feature.
 */
export const IMPACT_CONSUMER_RESOLUTIONS = ["identity", "string-match", "unverifiable"] as const;
export type ImpactConsumerResolution = (typeof IMPACT_CONSUMER_RESOLUTIONS)[number];

/** One sibling project that reads/writes an affected shared table — Epic #954 (#956). */
export interface ImpactTableConsumerView {
  projectId: string;
  projectName: string;
  usage: ImpactConsumerUsage;
  /** Schema-qualified identity of the object as this consumer references it. */
  objectQualifiedName: string;
}

// ---- API view --------------------------------------------------------------

/** A single affected table/column surfaced in the detail view. */
export interface ImpactAffectedTableView {
  id: string;
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
   * Issue #957 (Epic #954) — deterministic DDL risk class for this row's
   * suggested change: `breaking` (destructive / needs-review), `expanding`
   * (additive / safe), or `neutral` (verify-only reference). Computed at
   * crossing time by the pure {@link classifyDdlRisk} and persisted on
   * `ImpactAffectedTable.riskClass`. Null only for legacy rows written before
   * this field existed (rendered without a risk badge).
   */
  riskClass?: DdlRiskClass | null;
  /**
   * #936 — persisted LLM output-relevance tier: `likely`/`possible` (primary) or
   * `unlikely` (secondary/low-confidence bucket). Null when the relevance filter
   * did not run (flag off / legacy row) — such rows render in the primary set.
   */
  relevanceTier?: "likely" | "possible" | "unlikely" | null;
  /** #936 — one-line LLM rationale for {@link relevanceTier}; null when not judged. */
  relevanceRationale?: string | null;
  /**
   * Epic #954 (#956) — how the cross-project consumer set was resolved for this
   * physical table, or null/undefined when not computed (single-project /
   * no-workspace context ⇒ the row renders exactly as before this feature). See
   * {@link ImpactConsumerResolution}.
   */
  consumerResolution?: ImpactConsumerResolution | null;
  /**
   * Epic #954 (#956) — the OTHER projects that read/write this shared table.
   * Empty when {@link consumerResolution} is `identity`/`string-match` with no
   * match (a verified/heuristic "no consumers") or `unverifiable`. Omitted when
   * consumers were not computed.
   */
  consumers?: ImpactTableConsumerView[];
}

/**
 * Whether a {@link SchemaSource} represents live ground truth (`live-db`) vs an
 * inferred mapping (`mybatis`/`orm`/`ddl-file`). Drives the UI provenance badge.
 */
export function isLiveSchemaSource(source: SchemaSource): boolean {
  return source === "live-db";
}

// ---- Used-vs-full reconciliation & classification (Epic #292) --------------

/**
 * Per-object usage classification produced by reconciling the introspected full
 * schema (`driver.introspect()`) against the code→schema graph edges (#296/#297).
 *
 *   - `used`         — the object has at least one inbound code edge
 *                      (`reads`/`writes`/`persists-to`).
 *   - `unreferenced` — the object exists in the live introspection but NO code
 *                      edge points at it. A *candidate for review* only —
 *                      METIS NEVER auto-recommends dropping it.
 *   - `uncertain`    — static analysis cannot decide: dynamic SQL, an unresolved
 *                      reference, or an edge whose reconciliation is
 *                      `table-not-found`/`column-not-found`. MUST carry a
 *                      {@link UsageUncertainReason} and is NEVER safe-to-drop.
 */
export const USAGE_CLASSES = ["used", "unreferenced", "uncertain"] as const;
export type UsageClass = (typeof USAGE_CLASSES)[number];

/**
 * Reason code attached to every `uncertain` classification so the UI/doc can
 * explain *why* the object could not be classified and so a future manual
 * override (Phase 3 #304) can target a specific cause. Never null on `uncertain`.
 */
export const USAGE_UNCERTAIN_REASONS = [
  /** An inbound edge resolved to a table absent from the live introspection. */
  "table-not-found",
  /** An inbound edge resolved to a column absent from the live introspection. */
  "column-not-found",
  /** The reference came from dynamic SQL / a statically-unresolved edge. */
  "dynamic-reference",
  /**
   * A routine (procedure/function) whose body could not be statically analyzed.
   * Epic #293 Phase 2 (#302): Phase 2 introspects routine existence/signature
   * only — it does NOT parse routine bodies (that is Phase 3, #294), so a routine
   * whose body-derived references are unknown is `uncertain` and NEVER
   * auto-recommended for dropping.
   */
  "routine-body-unanalyzed",
] as const;
export type UsageUncertainReason = (typeof USAGE_UNCERTAIN_REASONS)[number];

/**
 * A single inbound edge cited as evidence for a classification. Preserved even
 * for unmatched edges (`reconciliation = table-not-found|column-not-found`) so
 * the UI/doc can show *why* an object is `used` or `uncertain`.
 */
export interface UsageEvidence {
  /** The schema edge kind that points at this object. */
  edgeKind: SchemaEdgeKind;
  /** Provenance of the edge (`live-db|mybatis|orm|ddl-file`). */
  source: SchemaSource;
  /** Originating code symbol's qualified name, when known. */
  fromQualifiedName: string | null;
  /** Reconciliation of the edge vs the live schema, when computed. */
  reconciliation: SchemaReconciliation | null;
}

/**
 * Reconciler output for one schema object (#296). Pure data — no persistence.
 * `tableName`/`columnName` are schema-qualified-table + bare-column identities.
 */
export interface ReconciledObject {
  kind: UsageObjectKind;
  /** Schema-qualified table identity (`<schema>.<table>` or bare `<table>`). */
  tableName: string;
  /** Bare column name for column objects; `null` for table objects. */
  columnName: string | null;
  /** Live column type when the object is a column present in introspection. */
  columnType: string | null;
  /** True when the object exists in the introspected full schema. */
  existsInSchema: boolean;
  /** Inbound code-edge evidence (empty when no edge points at the object). */
  evidence: UsageEvidence[];
}

/**
 * A classified schema object (#297): a {@link ReconciledObject} plus its derived
 * {@link UsageClass}. `uncertainReason` is non-null IFF `usageClass` is
 * `uncertain`. `safeToReview` flags `unreferenced` candidates a human MAY review
 * for removal; it is NEVER true for `uncertain` and NEVER implies auto-drop.
 */
export interface ClassifiedObject extends ReconciledObject {
  usageClass: UsageClass;
  uncertainReason: UsageUncertainReason | null;
  /** True only for `unreferenced` objects — a human review candidate, not a drop. */
  safeToReview: boolean;
}

/**
 * Manual-override assertion (Epic #294 #304). Lets an analyst correct/augment a
 * usage edge the parser cannot derive from dynamic SQL — e.g. assert that a
 * procedure invoked via a runtime-built string DOES touch `orders.total`. The
 * override is persisted with `source = "manual"` and takes precedence over
 * derived classifications (see {@link SCHEMA_SOURCE_PRECEDENCE}).
 *
 *   - `tableName`/`columnName` identify the target object (column null = table).
 *   - `usageClass` is the asserted class (typically `used`).
 *   - `access` is the asserted access kind for the emitted schema edge.
 *   - `note` is an optional human rationale.
 */
export const manualUsageOverrideSchema = z.object({
  kind: z.enum(USAGE_OBJECT_KINDS),
  tableName: z.string().min(1).max(512),
  columnName: z.string().min(1).max(512).nullable().optional(),
  usageClass: z.enum(USAGE_CLASSES),
  access: z.enum(SCHEMA_OBJECT_EDGE_KINDS).default("reads"),
  note: z.string().max(2000).nullable().optional(),
});
export type ManualUsageOverrideInput = z.infer<typeof manualUsageOverrideSchema>;

/** API view of a persisted manual override — Epic #294 (#304). */
export interface ManualUsageOverrideView {
  id: string;
  projectId: string;
  kind: UsageObjectKind;
  tableName: string;
  columnName: string | null;
  usageClass: UsageClass;
  access: SchemaObjectEdgeKind;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** API view of a persisted usage classification, scoped to one project. */
export interface SchemaUsageClassificationView {
  id: string;
  projectId: string;
  kind: UsageObjectKind;
  tableName: string;
  columnName: string | null;
  columnType: string | null;
  usageClass: UsageClass;
  uncertainReason: UsageUncertainReason | null;
  /** Inbound-edge evidence, persisted as structured JSON. */
  evidence: UsageEvidence[];
  /** Manual-override seam (Phase 3 #304). Null until a human overrides. */
  overriddenClass: UsageClass | null;
  computedAt: string;
}

// ---- Database-aware analysis opt-in (Epic #852, design #851) --------------

/**
 * `Project.databaseAwareAnalysis` legal values — Epic #852 Phase 1 (#853).
 * Replaces the hidden global env flags (`ANALYSIS_AFFECTED_SCHEMA_MAPPING` /
 * `ANALYSIS_SCHEMA_IMPACT`) with a single discoverable per-project intent
 * that moves BOTH the run-side prompts and the gap-report section together.
 *
 *   - `auto` (default) — resolves ENABLED when the project has a connected
 *     `DatabaseConnection` OR the schema graph (table/column `CodeSymbol`
 *     rows) is non-empty; resolves DISABLED otherwise. The resolver (plus
 *     the platform env kill-switch) is implemented in #854 — this constant
 *     and the column it validates are added in #853 only.
 *   - `on` / `off` — explicit per-project overrides.
 *
 * Stored as a `String` column (not a Prisma `enum`) for sqlite/postgres twin
 * portability, matching `Project.safetyMode` / `Project.sandboxProvider`
 * (see `server/prisma/schema.prisma`). ALWAYS validate a write against this
 * whitelist before persisting — never trust a raw client-supplied string
 * (OWASP A03: injection / improper input validation).
 */
export const DATABASE_AWARE_ANALYSIS_SETTINGS = ["auto", "on", "off"] as const;
export type DatabaseAwareAnalysisSetting = (typeof DATABASE_AWARE_ANALYSIS_SETTINGS)[number];

/** The `Project.databaseAwareAnalysis` column default (`@default("auto")`). */
export const DEFAULT_DATABASE_AWARE_ANALYSIS_SETTING: DatabaseAwareAnalysisSetting = "auto";

/** Zod validator for a {@link DatabaseAwareAnalysisSetting}. */
export const databaseAwareAnalysisSettingSchema = z.enum(DATABASE_AWARE_ANALYSIS_SETTINGS);

/**
 * `PATCH /api/projects/:id/database-aware-analysis` request payload. The
 * route itself is added in #857 (Phase 3); the shared contract is added now
 * so the write path has a single whitelist to validate against from day one.
 */
export const updateDatabaseAwareAnalysisSchema = z.object({
  databaseAwareAnalysis: databaseAwareAnalysisSettingSchema,
});
export type UpdateDatabaseAwareAnalysisInput = z.infer<typeof updateDatabaseAwareAnalysisSchema>;

// ---- SQL-lineage opt-in (Epic #882, #894) ----------------------------------

/**
 * `Project.sqlLineage` legal values — Epic #882 Phase 3 (#894). Mirrors
 * {@link DATABASE_AWARE_ANALYSIS_SETTINGS} exactly: replaces sole reliance on
 * the hidden global `SQL_LINEAGE_MODE` env flag with a discoverable
 * per-project intent that gates the non-ORM SQL-lineage extraction pass
 * (embedded SQL / SAS PROC SQL / routine bodies / Tier-1 catalog
 * dependencies — `server/src/lib/code-graph/ingest.ts`'s `extractSchemaUsage`
 * step).
 *
 *   - `auto` (default) — defers to the platform default
 *     (`SQL_LINEAGE_MODE=sidecar`); byte-identical to pre-#894 behavior.
 *   - `on` / `off` — explicit per-project overrides, always reachable
 *     regardless of the platform env flag (mirrors `databaseAwareAnalysis`'s
 *     `on`/`off` semantics — an explicit intent is never second-guessed).
 *
 * Stored as a `String` column (not a Prisma `enum`) for sqlite/postgres twin
 * portability. ALWAYS validate a write against this whitelist before
 * persisting — never trust a raw client-supplied string (OWASP A03).
 */
export const SQL_LINEAGE_SETTINGS = ["auto", "on", "off"] as const;
export type SqlLineageSetting = (typeof SQL_LINEAGE_SETTINGS)[number];

/** The `Project.sqlLineage` column default (`@default("auto")`). */
export const DEFAULT_SQL_LINEAGE_SETTING: SqlLineageSetting = "auto";

/** Zod validator for a {@link SqlLineageSetting}. */
export const sqlLineageSettingSchema = z.enum(SQL_LINEAGE_SETTINGS);

/** `PATCH /api/projects/:id/sql-lineage` request payload. */
export const updateSqlLineageSchema = z.object({
  sqlLineage: sqlLineageSettingSchema,
});
export type UpdateSqlLineageInput = z.infer<typeof updateSqlLineageSchema>;

/** Machine-readable reason {@link resolveSqlLineage} arrived at its decision. */
export const SQL_LINEAGE_REASONS = [
  "off",
  "on",
  "auto->platform-enabled",
  "auto->platform-disabled",
] as const;
export type SqlLineageReason = (typeof SQL_LINEAGE_REASONS)[number];
