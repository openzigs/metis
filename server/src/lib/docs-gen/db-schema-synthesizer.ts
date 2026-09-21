/**
 * DB Schema Document Synthesizer (Epic #672 / Issue #677).
 *
 * Introspects a connected database via `inspectDbConnector`, builds a Mermaid
 * ER diagram, and uses an LLM to produce prose descriptions for each table.
 * The resulting markdown document contains:
 *   - Overview paragraph
 *   - Mermaid ER diagram
 *   - Table-by-table reference section
 */
import { buildProvider, loadAIConfig } from "../ai/index.js";
import { createChildLogger } from "../logger.js";
import { inspectDbConnector, getDbConnector } from "../connectors/db/db-service.js";
import type {
  DbTableInfo,
  SchemaGraph,
  SchemaUsageClassificationView,
  UsageEvidence,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { readUsageClassification } from "../impact-analysis/used-schema-classifier.js";
import { detectTruncation, describeTruncation } from "./truncation.js";
import { resolveDbSchemaProseMaxOutputTokens } from "./output-caps.js";
import {
  sectionFailedWarning,
  sectionTruncatedWarning,
  type DocWarning,
} from "./grounding/degraded-warnings.js";

const log = createChildLogger("docs-gen:db-schema");

export const DB_SCHEMA_PROSE_PROMPT_VERSION = 1;

/**
 * Default maximum number of tables included in the Mermaid ER diagram.
 * ER diagrams beyond ~50 nodes are unreadable; extra tables are listed in
 * the Table Reference section but omitted from the diagram. Overridable via
 * the `DB_SCHEMA_SYNTH_MAX_TABLES_ER` environment variable.
 */
export const MAX_TABLES_ER = 50;

/**
 * Default number of tables described per LLM call. A larger batch reduces the
 * number of round trips for big schemas. Overridable via
 * `DB_SCHEMA_SYNTH_BATCH_SIZE` (clamped to 1..100).
 */
export const DEFAULT_LLM_BATCH_SIZE = 30;

/**
 * Default budget on the number of LLM calls a single synthesis may make. This
 * replaces the old hard 150-table truncation: instead of silently dropping
 * tables, prose generation stops gracefully once the call budget is exhausted
 * while every table still appears in the Table Reference. Overridable via
 * `DB_SCHEMA_SYNTH_LLM_CALL_BUDGET`.
 */
export const DEFAULT_LLM_CALL_BUDGET = 20;

/**
 * Default approximate input-token budget per synthesis run. Estimated as
 * `prompt.length / 4` per batch; prose generation stops once the budget would
 * be exceeded. Overridable via `DB_SCHEMA_SYNTH_LLM_TOKEN_BUDGET`.
 */
export const DEFAULT_LLM_TOKEN_BUDGET = 60000;

export interface SynthConfig {
  /** Tables described per LLM call. */
  batchSize: number;
  /** Maximum tables rendered in the ER diagram. */
  maxTablesEr: number;
  /** Maximum number of LLM calls allowed per synthesis run. */
  llmCallBudget: number;
  /** Approximate input-token budget per synthesis run. */
  llmTokenBudget: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number, max?: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return max != null ? Math.min(n, max) : n;
}

/**
 * Resolve the synthesis budget configuration from environment variables,
 * falling back to the documented defaults.
 */
export function loadSynthConfig(env: NodeJS.ProcessEnv = process.env): SynthConfig {
  return {
    batchSize: parsePositiveInt(env.DB_SCHEMA_SYNTH_BATCH_SIZE, DEFAULT_LLM_BATCH_SIZE, 100),
    maxTablesEr: parsePositiveInt(env.DB_SCHEMA_SYNTH_MAX_TABLES_ER, MAX_TABLES_ER),
    llmCallBudget: parsePositiveInt(env.DB_SCHEMA_SYNTH_LLM_CALL_BUDGET, DEFAULT_LLM_CALL_BUDGET),
    llmTokenBudget: parsePositiveInt(
      env.DB_SCHEMA_SYNTH_LLM_TOKEN_BUDGET,
      DEFAULT_LLM_TOKEN_BUDGET,
    ),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result of {@link synthesizeDbSchemaDocument}: the rendered markdown plus an
 * optional structured schema graph (Epic #895). `schemaGraph` is `null` for
 * error/empty documents where there is no schema to graph.
 */
export interface DbSchemaSynthResult {
  markdown: string;
  schemaGraph: SchemaGraph | null;
  generationModel: string | null;
  /**
   * #1228 — degraded-output warnings for prose generation that failed. Empty on
   * a clean run AND on a run that stopped gracefully at its configured call/token
   * budget, which is designed behaviour rather than a degradation. The caller
   * persists these and derives the document status from them, so a document that
   * described nothing can no longer ship as `ready` with `warnings = NULL`.
   */
  warnings: DocWarning[];
}

/** The section label every DB-schema prose warning is filed under. */
const PROSE_WARNING_SECTION = "Table Reference";

/**
 * Generate a DB schema document for the given connector.
 *
 * Never throws — on error the returned markdown embeds a user-friendly message
 * so the `GeneratedDocument` row can reach `ready` status with the error
 * inline rather than landing in `failed` state.
 *
 * Returns both the markdown document and a structured {@link SchemaGraph}
 * (tables + FK edges + LLM descriptions) for the interactive explorer. The
 * markdown output is unchanged from prior behaviour — the graph is additive.
 */
export async function synthesizeDbSchemaDocument(
  projectId: string,
  dbConnectorId: string,
  actorId: string,
  title: string,
): Promise<DbSchemaSynthResult> {
  log.info("Starting DB schema synthesis", { projectId, dbConnectorId });

  let tables: DbTableInfo[];
  let connectorLabel: string = dbConnectorId;

  try {
    const snapshot = await inspectDbConnector(projectId, dbConnectorId, actorId);
    tables = snapshot.tables;

    // Try to get a human label from the connector record
    try {
      const conn = await getDbConnector(projectId, dbConnectorId);
      connectorLabel = conn.label ?? dbConnectorId;
    } catch {
      // non-fatal — use id as fallback
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("DB inspection failed; returning error doc", { projectId, dbConnectorId, err: msg });
    return {
      markdown: renderErrorDocument(title, msg),
      schemaGraph: null,
      generationModel: null,
      warnings: [],
    };
  }

  if (tables.length === 0) {
    return {
      markdown: renderEmptyDocument(title, connectorLabel),
      schemaGraph: null,
      generationModel: null,
      warnings: [],
    };
  }

  const config = loadSynthConfig();

  const erTables =
    tables.length > config.maxTablesEr ? tables.slice(0, config.maxTablesEr) : tables;
  const erCapped = tables.length > config.maxTablesEr;
  log.info("Building ER diagram", {
    projectId,
    tableCount: tables.length,
    erTableCount: erTables.length,
    erCapped,
  });
  const erDiagram = buildErDiagram(erTables);

  log.info("Generating table prose with LLM", {
    projectId,
    tableCount: tables.length,
    batchSize: config.batchSize,
    llmCallBudget: config.llmCallBudget,
    llmTokenBudget: config.llmTokenBudget,
  });
  const prose = await generateTableDescriptions(tables, projectId, config);
  log.info("Prose generation complete", {
    projectId,
    // #1228 — tables actually DESCRIBED, derived from the description map the
    // document renders from. The old counter reported tables merely attempted.
    proseTableCount: prose.proseTableCount,
    attemptedTableCount: prose.attemptedTableCount,
    failedBatches: prose.failures.length,
    budgetExhausted: prose.budgetExhausted,
  });

  const timestamp = new Date().toISOString();
  let markdown = assembleDocument(
    title,
    connectorLabel,
    tables,
    erDiagram,
    prose.descriptions,
    timestamp,
    {
      erCapped,
      maxTablesEr: config.maxTablesEr,
      proseBudgetExhausted: prose.budgetExhausted,
      proseAttemptedTableCount: prose.attemptedTableCount,
      // Only WHOLLY LOST batches, so the banner's "did not return usable
      // descriptions" is literally true. A batch that described most of its
      // tables is in `prose.failures` and in the log, but naming it here would
      // misdescribe a healthy run.
      proseFailureCount: lostBatches(prose.failures).length,
    },
  );

  // Epic #292 (#299) — append the used-objects classification section when a
  // classification has been computed for this project. The full-schema sections
  // above are left untouched; this is purely additive and best-effort (a read
  // failure must never sink the document).
  try {
    const classification = await readUsageClassification(prisma, projectId);
    const usageSection = buildUsageClassificationSection(classification);
    if (usageSection) markdown = `${markdown}\n${usageSection}`;
  } catch (err) {
    log.warn("Could not append used-objects section; skipping", { projectId, err });
  }

  const schemaGraph = buildSchemaGraph(tables, prose.descriptions);
  return {
    markdown,
    schemaGraph,
    generationModel: prose.generationModel,
    warnings: buildProseWarnings(prose, tables.length),
  };
}

/**
 * #1228 — turn prose-generation failures into surfaceable document warnings.
 *
 * Two shortfalls deliberately produce NO warning, because `deriveDocStatus`
 * degrades a document on *any* warning and a degraded database document is a
 * materially worse artefact — the UI hides the Schema Graph explorer behind a
 * status check, so over-flagging costs the user a feature:
 *
 *  - **a graceful budget stop**, which is the documented behaviour for a large
 *    schema and would otherwise degrade nearly every one of them; and
 *  - **a batch that landed short but not empty** (29 of 30 described). The
 *    shortfall is still recorded in {@link ProseResult.failures} and logged — the
 *    issue asks for it to be recorded, not for it to fail the document — but a
 *    model declining to describe one lookup table is not a generation failure.
 *
 * A batch that returned NOTHING usable is. So is a truncated one, and so is a
 * provider that could not be built at all: every one of those means tables the
 * document was supposed to describe have no description and no explanation.
 *
 * Pure and deterministic, so the mapping from failure to warning is unit
 * testable without a provider.
 */
/**
 * #1228 — the batches that returned NOTHING usable, as opposed to those that
 * merely landed short. `storedCount === 0` is the whole distinction, and it is
 * computed here once so the document warning and the overview banner cannot
 * describe different sets — the same discipline {@link countDescribedTables}
 * applies to the count itself. Truncation is excluded because it carries its own,
 * more specific warning.
 */
export function lostBatches(failures: ProseBatchFailure[]): ProseBatchFailure[] {
  return failures.filter((f) => f.reason !== "truncated-response" && f.storedCount === 0);
}

export function buildProseWarnings(prose: ProseResult, totalTables: number): DocWarning[] {
  const warnings: DocWarning[] = [];
  const truncated = prose.failures.filter((f) => f.reason === "truncated-response");
  if (truncated.length > 0) {
    warnings.push(
      sectionTruncatedWarning(
        PROSE_WARNING_SECTION,
        `${truncated.length} table-description batch(es) cut off ` +
          `(${truncated[0]?.detail ?? "output cap"})`,
        prose.maxOutputTokens,
        "DOCS_GEN_DB_SCHEMA_MAX_OUTPUT_TOKENS",
      ),
    );
  }

  const lost = lostBatches(prose.failures);
  if (lost.length > 0) {
    const reasons = [...new Set(lost.map((f) => f.reason))].join(", ");
    warnings.push(
      sectionFailedWarning(
        PROSE_WARNING_SECTION,
        `AI prose descriptions were produced for ${prose.proseTableCount} of ${totalTables} ` +
          `tables — ${lost.length} generation attempt(s) returned nothing usable (${reasons}). ` +
          `Every table is still documented with its complete column schema, but the ` +
          `AI-written purpose text is missing.`,
      ),
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Used-objects classification section (Epic #292 — #299)
// ---------------------------------------------------------------------------

/** Escape `|` so identifiers don't break the markdown table layout. */
function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/** Human label for a usage class. `uncertain` is always clearly flagged. */
const USAGE_CLASS_LABEL: Record<string, string> = {
  used: "used",
  unreferenced: "unreferenced",
  uncertain: "uncertain",
};

/** Render one object's evidence as a compact, citation-style string. */
function renderEvidence(evidence: UsageEvidence[]): string {
  if (evidence.length === 0) return "—";
  return evidence
    .slice(0, 5)
    .map((e) => {
      const from = e.fromQualifiedName ? escapeCell(e.fromQualifiedName) : "?";
      const recon = e.reconciliation ? ` (${e.reconciliation})` : "";
      return `${e.edgeKind} ← ${from} [${e.source}]${recon}`;
    })
    .join("; ");
}

/**
 * Build the "Used Objects" markdown section from the persisted classification
 * (#297). Lists every table/column with its used/unreferenced/uncertain class
 * and the evidence references. Returns `""` when there is no classification so
 * the caller can omit the section entirely — the full-schema documentation is
 * never altered.
 *
 * Safety contract (#292): `uncertain` objects are clearly labeled and the
 * section NEVER describes any object as droppable/removable. `unreferenced`
 * objects are explicitly framed as review candidates only.
 *
 * Pure and deterministic — no I/O — so it is cheap to unit test.
 */
export function buildUsageClassificationSection(views: SchemaUsageClassificationView[]): string {
  if (views.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Used Objects");
  lines.push("");
  lines.push(
    "This section reconciles the full schema above against the code that " +
      "references it. Each object is classified as **used** (referenced by code), " +
      "**unreferenced** (present in the database but not referenced by any analyzed " +
      "code), or **uncertain** (the reference could not be statically resolved — " +
      "e.g. dynamic SQL, or a reference to an object missing from the live schema).",
  );
  lines.push("");
  lines.push(
    "> Unreferenced objects are **candidates for human review only** — METIS does " +
      "not recommend any schema change. Uncertain objects must be investigated " +
      "manually and must never be treated as unused.",
  );
  lines.push("");
  lines.push("| Object | Type | Classification | Reason | Evidence |");
  lines.push("|--------|------|----------------|--------|----------|");

  for (const v of views) {
    const objectName =
      v.kind === "column" && v.columnName
        ? `${escapeCell(v.tableName)}.${escapeCell(v.columnName)}`
        : escapeCell(v.tableName);
    const klass = USAGE_CLASS_LABEL[v.usageClass] ?? escapeCell(v.usageClass);
    const reason = v.usageClass === "uncertain" ? escapeCell(v.uncertainReason ?? "unknown") : "—";
    lines.push(
      `| ${objectName} | ${v.kind} | ${klass} | ${reason} | ${renderEvidence(v.evidence)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Schema graph builder (Epic #895)
// ---------------------------------------------------------------------------

/**
 * Assemble a structured {@link SchemaGraph} from the introspected tables and
 * the LLM-generated descriptions. Every table becomes a node (with its full
 * column list + PK/FK/nullable flags and description); every foreign key
 * becomes a directed edge from the FK-holding table to the referenced table.
 *
 * Nodes and edges are keyed by a schema-qualified id (`"<schema>.<name>"`) so
 * that same-named tables across different schemas (e.g. the multi-schema Oracle
 * target) remain distinct rather than collapsing into one node. FK edge targets
 * resolve against the referenced table's `refSchema`, falling back to the
 * source table's own schema when `refSchema` is absent. The displayed node
 * label is the bare table name.
 *
 * Pure and deterministic — no I/O — so it is cheap to unit test.
 */
export function buildSchemaGraph(
  tables: DbTableInfo[],
  descriptions: Map<string, string>,
): SchemaGraph {
  const graphTables = tables.map((table) => ({
    id: qualifiedTableId(table.schema, table.name),
    schema: table.schema,
    name: table.name,
    description: descriptions.get(table.name) ?? "",
    columns: table.columns.map((col) => ({
      name: col.name,
      dataType: col.dataType,
      nullable: col.nullable,
      isPrimaryKey: col.isPrimaryKey,
      isForeignKey: col.isForeignKey,
    })),
  }));

  const edges: SchemaGraph["edges"] = [];
  for (const table of tables) {
    const sourceSchema = table.schema;
    const sourceId = qualifiedTableId(sourceSchema, table.name);
    for (const fk of table.foreignKeys) {
      // Resolve the FK target against its own schema, falling back to the
      // source table's schema when the introspector omitted `refSchema`.
      const targetSchema = fk.refSchema ?? sourceSchema;
      edges.push({
        source: sourceId,
        target: qualifiedTableId(targetSchema, fk.refTable),
        sourceSchema,
        targetSchema,
        columns: fk.columns,
        refColumns: fk.refColumns,
      });
    }
  }

  return { tables: graphTables, edges };
}

/**
 * Build the schema-qualified node identity used for graph nodes and FK edge
 * endpoints. Falls back to the bare name when no schema is available.
 */
function qualifiedTableId(schema: string | undefined, name: string): string {
  return schema ? `${schema}.${name}` : name;
}

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
  // Mermaid identifiers must not contain spaces, dots, or special chars
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function sanitizeMermaidType(dataType: string): string {
  // Mermaid types must be word chars only; truncate parenthetical sizes
  return (
    dataType
      .replace(/\(.*\)/, "")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .toLowerCase() || "text"
  );
}

// ---------------------------------------------------------------------------
// LLM prose generation
// ---------------------------------------------------------------------------

/** Why one table-description batch produced fewer descriptions than requested. */
export type ProseFailureReason =
  /** No AI provider could be constructed, so no batch was even attempted. */
  | "provider-unavailable"
  /** `provider.chat()` threw. */
  | "provider-error"
  /** The provider reported an output-cap stop, or the body carried the gateway placeholder. */
  | "truncated-response"
  /** The provider returned an empty body. */
  | "empty-response"
  /** A body arrived but no usable JSON description map could be extracted from it. */
  | "unparseable-response"
  /** JSON parsed, but fewer descriptions than tables matched a table in this schema. */
  | "incomplete-response";

/** One batch that did not fully land, with enough detail to act on. */
export interface ProseBatchFailure {
  /** Index of the first table in the batch, so the failure can be located. */
  batchStart: number;
  /** How many tables the batch asked about. */
  tableCount: number;
  /** How many descriptions were actually stored from it. */
  storedCount: number;
  reason: ProseFailureReason;
  /** Human-readable specifics (parser reason, truncation signal, error message). */
  detail: string;
}

interface ProseResult {
  descriptions: Map<string, string>;
  generationModel: string | null;
  /**
   * #1228 — number of tables for which a NON-EMPTY description was actually
   * stored. Derived from {@link descriptions}, the same map the table sections
   * and the schema graph are rendered from, so it cannot report more than the
   * document contains. The pre-#1228 field incremented by `batch.length` before
   * the call was even made and never came back down on failure.
   */
  proseTableCount: number;
  /** Number of tables prose generation was ATTEMPTED for. Never a success count. */
  attemptedTableCount: number;
  /** Number of LLM batches issued. */
  batchCount: number;
  /** True when the LLM call or token budget was reached before all tables were covered. */
  budgetExhausted: boolean;
  /** Batches that failed or landed short. Empty on a clean run. */
  failures: ProseBatchFailure[];
  /** The OUTPUT cap in force for these calls, for the operator-facing warning. */
  maxOutputTokens: number;
}

/**
 * Count tables carrying a non-empty description. The ONE derivation used by the
 * overview banner, the returned {@link ProseResult} and the log line, so none of
 * them can claim a number the Table Reference does not show.
 */
/**
 * #1228 — the lookup used to match a model-supplied table name back to a real
 * table.
 *
 * Two maps rather than one, because case-insensitive matching must never be
 * allowed to *lose* a match that an exact comparison would have made. Postgres
 * and MySQL both permit `Foo` and `foo` as distinct tables in one schema; folding
 * them to a single key would route both descriptions onto whichever table came
 * first and leave the other with none — worse than the unconditional
 * `descriptions.set()` this replaces.
 */
export interface TableKeyIndex {
  /** Verbatim table name → itself. Always consulted first. */
  exact: Map<string, string>;
  /**
   * Lowercased table name → the table name, containing ONLY keys that exactly
   * one table normalizes to. An ambiguous key is omitted, so a case-insensitive
   * answer for such a name simply does not match rather than matching the wrong
   * table.
   */
  normalized: Map<string, string>;
}

/** Build the {@link TableKeyIndex} for one schema snapshot. */
export function buildTableKeyIndex(tables: DbTableInfo[]): TableKeyIndex {
  const exact = new Map<string, string>();
  const byNormalized = new Map<string, Set<string>>();
  for (const table of tables) {
    exact.set(table.name, table.name);
    const key = table.name.toLowerCase();
    const bucket = byNormalized.get(key);
    if (bucket) bucket.add(table.name);
    else byNormalized.set(key, new Set([table.name]));
  }

  const normalized = new Map<string, string>();
  for (const [key, names] of byNormalized) {
    if (names.size === 1) normalized.set(key, [...names][0] as string);
  }
  return { exact, normalized };
}

/**
 * Resolve a model-supplied name to the table key the document renders under, or
 * `undefined` when it matches no table in this schema.
 *
 * In order: the verbatim name; the verbatim segment after the last `.` (so a
 * schema- or catalog-qualified answer still lands); then the same two folded to
 * lower case, which only match a name no other table shares.
 */
export function resolveTableKey(name: string, index: TableKeyIndex): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return undefined;
  const bare = trimmed.slice(trimmed.lastIndexOf(".") + 1);
  return (
    index.exact.get(trimmed) ??
    index.exact.get(bare) ??
    index.normalized.get(trimmed.toLowerCase()) ??
    index.normalized.get(bare.toLowerCase())
  );
}

export function countDescribedTables(descriptions: Map<string, string>): number {
  let n = 0;
  for (const desc of descriptions.values()) {
    if (desc.trim() !== "") n += 1;
  }
  return n;
}

/** Why {@link parseTableDescriptions} could not extract a description map. */
export type DescriptionParseReason =
  | "empty-response"
  | "no-json-object"
  | "unterminated-json"
  | "invalid-json"
  | "no-descriptions-field";

/** Outcome of extracting a table-description map from a model response. */
export interface ParsedDescriptions {
  ok: boolean;
  /** Name → description. Empty when `ok` is false. */
  descriptions: Record<string, string>;
  /** Present only when `ok` is false. */
  reason?: DescriptionParseReason;
}

/**
 * How many `{` positions are tried as a JSON candidate before giving up. A
 * well-formed response has one; a chatty model may put a brace in its preamble.
 * Bounded so a pathological body cannot make extraction quadratic.
 */
const MAX_JSON_CANDIDATES = 25;

/**
 * #1228 — tolerant extraction of the table-description map from a model
 * response, replacing the greedy `/\{[\s\S]*"descriptions"[\s\S]*\}/` regex.
 *
 * That regex needed a literal `}` *after* the word `descriptions`. The values in
 * this payload are plain strings, so a response cut off by the output cap
 * contains no closing brace at all and the match simply failed — silently, since
 * the call site had no `else`. This scanner instead walks braces with string and
 * escape awareness and reports WHY extraction failed, distinguishing the
 * truncation tell (`unterminated-json`) from a refusal or malformed body.
 *
 * Accepts `{"descriptions": {...}}` and, when no `descriptions` key is present
 * at all, a flat `{"TABLE": "text"}` map — both shapes models return in practice.
 * Non-string values are dropped rather than stringified into the document.
 *
 * Pure — no I/O, no provider — so every branch is cheap to test.
 */
export function parseTableDescriptions(text: string): ParsedDescriptions {
  if (text.trim() === "") return { ok: false, descriptions: {}, reason: "empty-response" };

  let sawCandidate = false;
  let sawUnterminated = false;
  let sawInvalid = false;
  let sawUnusable = false;
  let tried = 0;

  for (let i = 0; i < text.length && tried < MAX_JSON_CANDIDATES; i += 1) {
    if (text[i] !== "{") continue;
    sawCandidate = true;
    tried += 1;

    const end = findMatchingBrace(text, i);
    if (end === -1) {
      sawUnterminated = true;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(i, end + 1));
    } catch {
      sawInvalid = true;
      continue;
    }

    const map = coerceDescriptionMap(parsed);
    if (map === null) {
      sawUnusable = true;
      continue;
    }
    return { ok: true, descriptions: map };
  }

  if (!sawCandidate) return { ok: false, descriptions: {}, reason: "no-json-object" };
  // Truncation is the most actionable diagnosis, so it wins over a later
  // candidate that merely failed to parse.
  if (sawUnterminated) return { ok: false, descriptions: {}, reason: "unterminated-json" };
  if (sawUnusable && !sawInvalid) {
    return { ok: false, descriptions: {}, reason: "no-descriptions-field" };
  }
  return { ok: false, descriptions: {}, reason: "invalid-json" };
}

/**
 * Index of the `}` closing the `{` at `start`, or `-1` when the object is never
 * closed. String-literal and escape aware so a brace inside a description does
 * not unbalance the scan.
 */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Reduce a parsed JSON value to a name → description map, or `null` when it
 * carries none. A present-but-wrong `descriptions` field is rejected outright
 * rather than falling back to the wrapper object, which would otherwise emit
 * `{"descriptions": "<the model's apology>"}` as a table description.
 */
function coerceDescriptionMap(parsed: unknown): Record<string, string> | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  let source: Record<string, unknown>;
  if ("descriptions" in record) {
    const inner = record.descriptions;
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return null;
    source = inner as Record<string, unknown>;
  } else {
    source = record;
  }

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function generateTableDescriptions(
  tables: DbTableInfo[],
  projectId: string,
  config: SynthConfig,
): Promise<ProseResult> {
  const descriptions = new Map<string, string>();
  // Default every table to an empty description so the Table Reference renders
  // even when prose is skipped.
  for (const table of tables) {
    descriptions.set(table.name, "");
  }
  const tableKeys = buildTableKeyIndex(tables);

  let provider;
  try {
    const aiConfig = loadAIConfig();
    provider = buildProvider({ config: aiConfig });
  } catch (err) {
    log.warn("Could not build AI provider; skipping prose descriptions", { err });
    // #1228 — this is a FAILURE, not a graceful skip: the document ships with
    // zero descriptions. Returning no failure here left `deriveDocStatus` with an
    // empty warning list, so a misconfigured provider produced exactly the
    // `ready` / `warnings = NULL` document this issue exists to stop.
    return {
      descriptions,
      generationModel: null,
      proseTableCount: 0,
      attemptedTableCount: 0,
      batchCount: 0,
      budgetExhausted: false,
      failures: [
        {
          batchStart: 0,
          tableCount: tables.length,
          storedCount: 0,
          reason: "provider-unavailable",
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      maxOutputTokens: 0,
    };
  }

  // #1228 — an EXPLICIT output cap, sized for the model this provider instance
  // actually runs. Passing none inherited the provider's 4096 default, which cut
  // a 30-table JSON batch mid-object; because the values are plain strings the
  // brace never closed, so the whole batch failed to parse.
  const maxOutputTokens = resolveDbSchemaProseMaxOutputTokens(provider.model);

  const batchSize = config.batchSize;
  let callsUsed = 0;
  let tokensUsed = 0;
  let attemptedTableCount = 0;
  let budgetExhausted = false;
  const failures: ProseBatchFailure[] = [];

  for (let i = 0; i < tables.length; i += batchSize) {
    const batch = tables.slice(i, i + batchSize);
    const tableList = batch
      .map((t) => {
        const cols = t.columns.map((c) => `${c.name} (${c.dataType})`).join(", ");
        return `Table: ${t.name}\nColumns: ${cols}`;
      })
      .join("\n\n");

    const prompt = `You are a technical writer documenting a database schema. For each table listed below, write a 2-3 sentence description explaining its purpose and what data it stores. Be concise and factual.

${tableList}

Respond in JSON format: { "descriptions": { "tableName": "description", ... } }`;

    // Approximate the input-token cost of this batch (~4 chars/token).
    const estimatedTokens = Math.ceil(prompt.length / 4);

    // Budget check BEFORE spending the call. We always allow the first call so
    // that even a single oversized batch produces some prose.
    if (callsUsed >= config.llmCallBudget) {
      budgetExhausted = true;
      break;
    }
    if (callsUsed > 0 && tokensUsed + estimatedTokens > config.llmTokenBudget) {
      budgetExhausted = true;
      break;
    }

    callsUsed += 1;
    tokensUsed += estimatedTokens;
    attemptedTableCount += batch.length;

    const record = (reason: ProseFailureReason, detail: string, storedCount: number): void => {
      failures.push({ batchStart: i, tableCount: batch.length, storedCount, reason, detail });
      // #1228 — ALWAYS log. The pre-#1228 code logged only on a thrown error, so
      // a body that merely failed the regex left no trace anywhere.
      log.warn("DB schema table descriptions did not land for batch", {
        projectId,
        batchStart: i,
        tableCount: batch.length,
        storedCount,
        reason,
        detail,
        maxOutputTokens,
      });
    };

    let response;
    try {
      response = await provider.chat([{ role: "user", content: prompt }], {
        maxTokens: maxOutputTokens,
      });
    } catch (err) {
      record("provider-error", err instanceof Error ? err.message : String(err), 0);
      // Leave descriptions empty for this batch — markdown will show column table only
      continue;
    }

    const detection = detectTruncation(response.content ?? "", response.finishReason);
    const parsed = parseTableDescriptions(detection.text);

    let stored = 0;
    for (const [name, desc] of Object.entries(parsed.descriptions)) {
      // Only names that are actually in this schema count: a model that invents
      // a table must not inflate the count or add a section-less description.
      // Pre-#1228 this was an unconditional `descriptions.set(name, …)`, which
      // silently ADDED an entry under whatever key the model used — invisible to
      // the markdown and the graph, both of which look tables up by their own
      // name. A schema-qualified or differently-cased answer therefore produced
      // exactly the observed zero with no error anywhere.
      const key = resolveTableKey(name, tableKeys);
      if (key === undefined) continue;
      const trimmed = desc.trim();
      if (trimmed === "") continue;
      if (descriptions.get(key) === "") stored += 1;
      descriptions.set(key, trimmed);
    }

    if (detection.truncated) {
      record("truncated-response", describeTruncation(detection), stored);
    } else if (stored < batch.length) {
      const reason: ProseFailureReason = parsed.ok
        ? "incomplete-response"
        : parsed.reason === "empty-response"
          ? "empty-response"
          : "unparseable-response";
      record(reason, parsed.reason ?? `only ${stored} of ${batch.length} tables described`, stored);
    }
  }

  return {
    descriptions,
    generationModel: provider.model,
    proseTableCount: countDescribedTables(descriptions),
    attemptedTableCount,
    batchCount: callsUsed,
    budgetExhausted,
    failures,
    maxOutputTokens,
  };
}

// ---------------------------------------------------------------------------
// Markdown assembly
// ---------------------------------------------------------------------------

interface AssembleOpts {
  erCapped?: boolean;
  maxTablesEr?: number;
  proseBudgetExhausted?: boolean;
  /**
   * #1228 — how many tables prose was ATTEMPTED for. Used only to decide whether
   * to say anything at all: with no attempt (no provider) the document makes no
   * claim about prose. The number the banner REPORTS is derived from the
   * description map itself, never from this.
   */
  proseAttemptedTableCount?: number;
  /** #1228 — how many batches failed, so the banner can name the cause. */
  proseFailureCount?: number;
}

function assembleDocument(
  title: string,
  connectorLabel: string,
  tables: DbTableInfo[],
  erDiagram: string,
  tableDescriptions: Map<string, string>,
  timestamp: string,
  opts: AssembleOpts = {},
): string {
  const sections: string[] = [];

  sections.push(`# ${title}`);
  sections.push("");

  // Overview
  sections.push("## Overview");
  sections.push("");
  sections.push(
    `This document describes the database schema for **${connectorLabel}**, ` +
      `containing ${tables.length} table${tables.length !== 1 ? "s" : ""}. ` +
      `Generated on ${new Date(timestamp).toUTCString()}.`,
  );
  // #1228 — the banner counts the SAME description map the Table Reference and
  // the schema graph render from, so it is structurally incapable of claiming
  // prose the document does not contain. The pre-#1228 banner was handed a
  // counter incremented per ATTEMPT and reported 510 described when 0 were.
  const describedCount = countDescribedTables(tableDescriptions);
  const attempted = opts.proseAttemptedTableCount ?? 0;
  if (attempted > 0 && describedCount < tables.length) {
    const causes: string[] = [];
    if (opts.proseBudgetExhausted) causes.push("the configured generation budget was reached");
    if ((opts.proseFailureCount ?? 0) > 0) {
      causes.push(
        `${opts.proseFailureCount} generation batch(es) did not return usable descriptions`,
      );
    }
    const because = causes.length > 0 ? ` because ${causes.join(", and ")}` : "";
    sections.push("");
    sections.push(
      `> **Note:** AI-generated prose descriptions were produced for ` +
        `${describedCount} of ${tables.length} table${tables.length !== 1 ? "s" : ""}${because}. ` +
        `All ${tables.length} table${tables.length !== 1 ? "s" : ""} remain fully documented in ` +
        `the Table Reference section below with their complete column schema.`,
    );
  }
  sections.push("");

  // ER Diagram
  sections.push("## Entity Relationship Diagram");
  sections.push("");
  if (opts.erCapped) {
    sections.push(
      `> Showing the first ${opts.maxTablesEr} of ${tables.length} tables. See Table Reference for the full list.`,
    );
    sections.push("");
  }
  sections.push("```mermaid");
  sections.push(erDiagram);
  sections.push("```");
  sections.push("");

  // Table Reference
  sections.push("## Table Reference");
  sections.push("");

  for (const table of tables) {
    sections.push(`### ${table.name}`);
    sections.push("");

    const desc = tableDescriptions.get(table.name);
    if (desc) {
      sections.push(desc);
      sections.push("");
    }

    // Column table
    sections.push("| Column | Type | Constraints |");
    sections.push("|--------|------|-------------|");
    for (const col of table.columns) {
      const constraints: string[] = [];
      if (col.isPrimaryKey) constraints.push("PK");
      if (col.isForeignKey) constraints.push("FK");
      if (!col.nullable) constraints.push("NOT NULL");
      if (col.defaultValue != null) constraints.push(`DEFAULT: ${col.defaultValue}`);
      sections.push(`| ${col.name} | ${col.dataType} | ${constraints.join(", ")} |`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

function renderEmptyDocument(title: string, connectorLabel: string): string {
  return [
    `# ${title}`,
    "",
    "## Overview",
    "",
    `No tables were found for connector **${connectorLabel}**.`,
    "The database may be empty or the connected user may lack schema read permissions.",
    "",
  ].join("\n");
}

function renderErrorDocument(title: string, errorMessage: string): string {
  return [
    `# ${title}`,
    "",
    "> **Generation Error**",
    ">",
    `> The database schema could not be retrieved: ${errorMessage}`,
    ">",
    "> Please verify the database connector is connected and the user has schema read permissions.",
    "",
  ].join("\n");
}
