/**
 * Deterministic per-requirement AFFECTED SCHEMA context — Epic #820 Phase 1 (#823).
 *
 * This is the DATABASE twin of the code-side affected-code context (#735,
 * `./affected-code-context.ts`): where that module maps a requirement's change
 * to the code symbols it touches, this one replays the SAME impacted symbols
 * into the schema graph and renders the affected tables/columns (plus the
 * reconciliation status and the suggested DDL) as a token-budgeted DATA block
 * the analysis prompt can seed.
 *
 * It invents NO new traversal. It composes the existing Impact-Analysis engine:
 *   - {@link crossToSchema} (`../impact-analysis/schema-impact.ts`) follows the
 *     `reads`/`writes`/`persists-to`/`executes` edges from the impacted code
 *     symbols to the `table`/`column`/routine objects they touch, reconciles
 *     each against the live schema when a {@link LiveSchemaIndex} is supplied,
 *     and returns one {@link AffectedTableInput} per distinct object with a
 *     **suggested DDL string that is TEXT ONLY and is never executed** and a
 *     blended confidence (live-db 0.95 / matched 0.85 / not-found 0.4).
 *   - the optional {@link CrossProjectIdentityResolver} (1a / #821) is passed
 *     straight through so each affected row carries its cross-project
 *     `schemaObjectIdentityId` when a workspace/resource context exists — the
 *     input 1b (#822) / 1e (#825) consume. The single-project path works with
 *     no resolver.
 *
 * Design guarantees (mirroring `./affected-code-context.ts`):
 *   - **Deterministic**: `crossToSchema` dedupes + sorts, and the render orders
 *     rows by confidence so the same input yields a byte-identical block.
 *   - **Token-budgeted, carve-OUT**: the block is truncated deterministically at
 *     `DEFAULT_AFFECTED_SCHEMA_TOKEN_BUDGET` and capped at
 *     `DEFAULT_AFFECTED_SCHEMA_MAX_ROWS` (both overridable per call), keeping the
 *     HIGHEST-confidence rows; its cost is carved OUT of the consuming agent's
 *     budget by the caller.
 *   - **Degrades cleanly**: no impacted symbols, no schema edges, no schema
 *     graph, or a crossing failure all resolve to
 *     {@link EMPTY_AFFECTED_SCHEMA_CONTEXT} — the block is omitted rather than a
 *     fabricated empty section, and the computation never throws.
 *   - **Physical names**: rows carry the physical/mapped object names from the
 *     schema graph (e.g. `requirements`, not the `Requirement` Prisma model),
 *     because they originate from the introspected/`@@map`ped schema symbols.
 *   - **Read-only & safe**: the suggested DDL is rendered into a prompt and has
 *     no execution path; introspection inputs (#732) are read-only.
 */
import { createChildLogger } from "../logger.js";
import type { PrismaClient } from "@prisma/client";
import type { LiveSchemaIndex } from "../impact-analysis/live-schema-ingest.js";
import {
  crossToSchema,
  PrismaSchemaImpactDataSource,
  type AffectedTableInput,
  type CrossProjectIdentityResolver,
  type SchemaImpactDataSource,
} from "../impact-analysis/schema-impact.js";
import { getConfigService } from "../config/config-service.js";
import {
  DB_AWARE_PLATFORM_DEFAULT,
  DB_AWARE_PLATFORM_FLAG_KEYS,
} from "./database-aware-resolver.js";
import { heuristicChangeExtractor } from "../impact-analysis/extract-changes.js";
import {
  computeProjectImpact,
  PrismaCodeGraphDataSource,
} from "../impact-analysis/impact-analysis-engine.js";
import {
  mapRequirementToCode,
  type RequirementCodeMatch,
} from "../traceability/requirement-code-mapping.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import { prisma as defaultPrisma } from "../prisma.js";

const log = createChildLogger("affected-schema-context");

/**
 * The verbatim block header. It carries the safety label required by the issue
 * — the rendered block always contains "TEXT ONLY … never executed" so a reader
 * (human or model) can never mistake the suggested DDL for something applied.
 */
export const AFFECTED_SCHEMA_HEADER =
  "AFFECTED SCHEMA (deterministic, from impact analysis — suggested DDL is TEXT ONLY, for review, never executed)";

/** Default token budget for the rendered block (≈4 chars/token). */
export const DEFAULT_AFFECTED_SCHEMA_TOKEN_BUDGET = 1200;
/** Default upper bound on affected objects rendered into the block. */
export const DEFAULT_AFFECTED_SCHEMA_MAX_ROWS = 8;

/** 4 chars ≈ 1 token, matching `estimateAffectedCodeTokens` in `./affected-code-context.ts`. */
export function estimateAffectedSchemaTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/** Result of the deterministic affected-schema computation for one requirement. */
export interface AffectedSchemaContext {
  /**
   * The COMPLETE affected rows (deduped + sorted by `crossToSchema`; never
   * truncated) for persistence + downstream consumers (1e / #825). `truncated`
   * flags only that the rendered `block` omitted some rows to fit the budget.
   */
  rows: AffectedTableInput[];
  /** Fenced-ready DATA block (token-budgeted; `""` when nothing to show). */
  block: string;
  /** Estimated token cost of `block` (0 when empty) — carve this OUT of the
   * consuming agent's token budget rather than adding it on top. */
  tokens: number;
  /** True when the row cap or token budget dropped one or more affected rows. */
  truncated: boolean;
}

/** Empty, no-op result — the no-input / no-edges / no-graph / error shape. */
export const EMPTY_AFFECTED_SCHEMA_CONTEXT: AffectedSchemaContext = {
  rows: [],
  block: "",
  tokens: 0,
  truncated: false,
};

/** The physical/mapped object identity as it appears in the schema graph. */
function objectLabel(row: AffectedTableInput): string {
  return row.columnName ? `${row.tableName}.${row.columnName}` : row.tableName;
}

/**
 * Render one affected object as a single reference line (pure DATA). Carries the
 * mapped object name, its kind, the suggested DDL change kind, the live-schema
 * reconciliation status, the blended confidence, and the suggested DDL text.
 */
function renderSchemaLine(row: AffectedTableInput): string {
  const reconciliation = row.reconciliation ?? "unreconciled";
  const ddl = row.suggestedDdl ?? "(no DDL suggested)";
  return `  - ${objectLabel(row)} [${row.objectKind}, change=${row.changeKind}, reconciliation=${reconciliation}, conf ${row.confidence.toFixed(2)}] — ${ddl}`;
}

/**
 * Render the affected-object rows into a single DATA block under a hard token
 * budget and row cap. Rows are deduped per `(tableName, columnName)` (highest
 * confidence wins — mirroring `crossToSchema`) then ordered by confidence
 * descending, so truncation deterministically keeps the highest-confidence rows
 * and the output is byte-identical across runs. Returns `{ block: "", tokens: 0,
 * truncated: false }` when there is nothing to render, and `truncated: true`
 * when any row was omitted by the cap or the budget.
 *
 * PURE — no I/O — so the budget boundary is unit-testable in isolation. The
 * block is pure DATA: the header labels the suggested DDL as text-only, and the
 * prompt builder (1d / #824) wraps it in an untrusted-data fence.
 */
export function renderAffectedSchemaBlock(
  rows: AffectedTableInput[],
  tokenBudget: number,
  maxRows: number = DEFAULT_AFFECTED_SCHEMA_MAX_ROWS,
): { block: string; tokens: number; truncated: boolean } {
  // De-dupe per (tableName, columnName); the highest-confidence row wins so a
  // caller passing raw/duplicated rows still gets one line per object.
  const byKey = new Map<string, AffectedTableInput>();
  for (const r of rows) {
    const key = `${r.tableName}\u0000${r.columnName ?? ""}`;
    const existing = byKey.get(key);
    if (!existing || r.confidence > existing.confidence) byKey.set(key, r);
  }
  const distinct = [...byKey.values()];
  if (distinct.length === 0) return { block: "", tokens: 0, truncated: false };

  // Deterministic order: confidence desc (keep the strongest signal on
  // truncation), then object identity as a stable tiebreak.
  const ordered = distinct.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.tableName.localeCompare(b.tableName) ||
      (a.columnName ?? "").localeCompare(b.columnName ?? ""),
  );

  const total = ordered.length;
  const capped = ordered.slice(0, Math.max(0, maxRows));

  let assembled = AFFECTED_SCHEMA_HEADER;
  let kept = 0;
  for (const row of capped) {
    const line = `\n${renderSchemaLine(row)}`;
    if (estimateAffectedSchemaTokens(assembled + line) > tokenBudget) break;
    assembled += line;
    kept += 1;
  }

  // The header alone carries no data — if not even one row fit, emit nothing so
  // the caller omits the fenced section entirely (no fabricated section).
  if (kept === 0) return { block: "", tokens: 0, truncated: total > 0 };

  return {
    block: assembled,
    tokens: estimateAffectedSchemaTokens(assembled),
    truncated: kept < total,
  };
}

/**
 * Compute the deterministic affected-schema context for one requirement's
 * impacted code symbols. Crosses the symbols into the schema graph with
 * {@link crossToSchema} and renders a token-budgeted block. NEVER throws — a
 * crossing failure, no impacted symbols, or no schema edges all degrade to
 * {@link EMPTY_AFFECTED_SCHEMA_CONTEXT} so the analysis run is unaffected.
 *
 * `tokenBudget` / `maxRows` default to {@link DEFAULT_AFFECTED_SCHEMA_TOKEN_BUDGET}
 * / {@link DEFAULT_AFFECTED_SCHEMA_MAX_ROWS} (1200 / 8) and may be overridden per
 * call (the prompt integration 1d / #824 will wire operator config in).
 */
export async function computeAffectedSchemaContext(opts: {
  requirementId: string;
  affectedSymbolIds: string[];
  dataSource: SchemaImpactDataSource;
  liveIndex?: LiveSchemaIndex | null;
  identityResolver?: CrossProjectIdentityResolver | null;
  tokenBudget?: number;
  maxRows?: number;
}): Promise<AffectedSchemaContext> {
  const seedIds = opts.affectedSymbolIds.filter(Boolean);
  if (seedIds.length === 0) return EMPTY_AFFECTED_SCHEMA_CONTEXT;

  let rows: AffectedTableInput[];
  try {
    rows = await crossToSchema(
      seedIds,
      opts.dataSource,
      opts.liveIndex ?? null,
      opts.identityResolver ?? null,
    );
  } catch (err) {
    // A crossing failure must never sink the analysis — degrade to no block.
    log.warn("schema crossing failed; omitting affected-schema context", {
      requirementId: opts.requirementId,
      error: String(err),
    });
    return EMPTY_AFFECTED_SCHEMA_CONTEXT;
  }

  // No schema edges / no schema graph ⇒ empty context (block omitted).
  if (rows.length === 0) return EMPTY_AFFECTED_SCHEMA_CONTEXT;

  const tokenBudget = opts.tokenBudget ?? DEFAULT_AFFECTED_SCHEMA_TOKEN_BUDGET;
  const maxRows = opts.maxRows ?? DEFAULT_AFFECTED_SCHEMA_MAX_ROWS;

  const rendered = renderAffectedSchemaBlock(rows, tokenBudget, maxRows);
  return {
    rows,
    block: rendered.block,
    tokens: rendered.tokens,
    truncated: rendered.truncated,
  };
}

/** Default upper bound on requirement candidates mapped per run (mirrors #735). */
export const DEFAULT_AFFECTED_SCHEMA_MAX_CANDIDATES = 8;

type MapRequirementFn = (
  req: { id: string; title: string; body: string },
  projectId: string,
) => Promise<RequirementCodeMatch[]>;

type RunAffectedSchemaPrisma = Pick<
  PrismaClient,
  "codeSymbol" | "codeEdge" | "requirementCodeMapping" | "$transaction"
>;

/**
 * Injectable production seam for {@link computeRunAffectedSchemaContext},
 * mirroring `AffectedCodeDeps` (#735) plus a schema-graph data-source factory.
 * All optional — the defaults are the production BM25 mapper + Prisma code and
 * schema graph data sources, so tests can drive the whole crossing in-memory.
 */
export interface RunAffectedSchemaDeps {
  prisma?: RunAffectedSchemaPrisma;
  /** Requirement→code mapper. Defaults to the BM25 `mapRequirementToCode`. */
  mapRequirement?: MapRequirementFn;
  /** Code-graph data source factory. Defaults to `PrismaCodeGraphDataSource`. */
  dataSourceFor?: (projectId: string) => CodeGraphDataSource;
  /** Schema-graph data source factory. Defaults to `PrismaSchemaImpactDataSource`. */
  schemaDataSourceFor?: (projectId: string) => SchemaImpactDataSource;
  /**
   * #826 (Epic #820 Phase 1) — the run's live schema index, when one is
   * available, so each affected row is RECONCILED against ground truth
   * (`matched` / `table-not-found` / `column-not-found`) and the verdict gate can
   * downgrade a DDL claim the live schema cannot support. Omitted ⇒ reconciliation
   * stays `null` and behaviour is byte-identical to #823/#824.
   */
  liveIndex?: LiveSchemaIndex | null;
  /**
   * #826 — optional cross-project canonical-identity resolver (1a / #821). When
   * provided, each affected row carries its `schemaObjectIdentityId`, letting the
   * verdict gate treat an unresolved cross-project claim as unverifiable. Omitted
   * ⇒ no identity linking (single-project behaviour, unchanged).
   */
  identityResolver?: CrossProjectIdentityResolver | null;
}

/**
 * Compute the deterministic AFFECTED SCHEMA block for one analysis RUN — the
 * run-level entry point the orchestrator (1d / #824) calls to seed the database
 * (Sally), code, and synthesis prompts. It is the DATABASE twin of
 * `computeAffectedCodeContext` (#735): it parses the operator's free-text new
 * requirements into candidates, maps each to code symbols with the SAME Impact
 * Analysis machinery, then crosses the aggregated seed symbols into the schema
 * graph via {@link computeAffectedSchemaContext} (#823) — inventing no new
 * traversal.
 *
 * Design guarantees (mirroring `computeAffectedCodeContext`):
 *   - **Gated** by the caller's resolved `enabled` (#855), falling back to
 *     `ANALYSIS_AFFECTED_SCHEMA_MAPPING` — ON by default since #849 — for
 *     pre-#855 callers. Off ⇒ a clean no-op: the prompts + budgets are
 *     byte-identical to pre-#824.
 *   - **Deterministic**: extractor + BM25 + blast radius + `crossToSchema` are
 *     all deterministic, so the same input yields a byte-identical block.
 *   - **Degrades cleanly**: no requirements, no candidates, no code graph, no
 *     schema edges, or any failure all resolve to
 *     {@link EMPTY_AFFECTED_SCHEMA_CONTEXT} — never a throw, never an empty fence.
 *   - **Read-only & safe**: the suggested DDL is TEXT ONLY and never executed;
 *     introspection inputs are read-only.
 */
export async function computeRunAffectedSchemaContext(opts: {
  projectId: string;
  extraInstructions?: string | null;
  enabled?: boolean;
  tokenBudget?: number;
  maxRows?: number;
  maxCandidates?: number;
  deps?: RunAffectedSchemaDeps;
}): Promise<AffectedSchemaContext> {
  const cfg = getConfigService();
  const enabled =
    opts.enabled ??
    cfg.getBool(DB_AWARE_PLATFORM_FLAG_KEYS.affectedSchemaMapping, DB_AWARE_PLATFORM_DEFAULT);
  if (!enabled) return EMPTY_AFFECTED_SCHEMA_CONTEXT;

  const text = opts.extraInstructions?.trim() ?? "";
  if (text.length === 0) return EMPTY_AFFECTED_SCHEMA_CONTEXT;

  // Deterministic, LLM-free split into discrete requirement candidates — the
  // SAME splitter #735 uses. Any parse failure degrades to today's behaviour.
  let changes;
  try {
    changes = await heuristicChangeExtractor.extract(text);
  } catch (err) {
    log.warn("requirement-candidate extraction failed; skipping affected-schema mapping", {
      projectId: opts.projectId,
      error: String(err),
    });
    return EMPTY_AFFECTED_SCHEMA_CONTEXT;
  }
  if (changes.length === 0) return EMPTY_AFFECTED_SCHEMA_CONTEXT;

  const maxCandidates =
    opts.maxCandidates ??
    cfg.getNumber("ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES", DEFAULT_AFFECTED_SCHEMA_MAX_CANDIDATES);
  const tokenBudget =
    opts.tokenBudget ??
    cfg.getNumber("ANALYSIS_AFFECTED_SCHEMA_TOKEN_BUDGET", DEFAULT_AFFECTED_SCHEMA_TOKEN_BUDGET);
  const maxRows =
    opts.maxRows ??
    cfg.getNumber("ANALYSIS_AFFECTED_SCHEMA_MAX_ROWS", DEFAULT_AFFECTED_SCHEMA_MAX_ROWS);

  const prisma = (opts.deps?.prisma ??
    (defaultPrisma as unknown as RunAffectedSchemaPrisma)) as RunAffectedSchemaPrisma;
  const mapRequirement: MapRequirementFn =
    opts.deps?.mapRequirement ??
    ((req, projectId) => mapRequirementToCode(req, projectId, {}, { prisma }));
  const dataSourceFor =
    opts.deps?.dataSourceFor ??
    ((projectId: string) => new PrismaCodeGraphDataSource(prisma, projectId));
  const schemaDataSourceFor =
    opts.deps?.schemaDataSourceFor ??
    ((projectId: string) => new PrismaSchemaImpactDataSource(prisma, projectId));

  // Aggregate the seed code-symbol IDs (direct hits + blast radius) each
  // candidate maps to; those are what `crossToSchema` follows into the schema
  // graph. `includeSchemaImpact:false` keeps this a pure code-symbol pass — the
  // crossing happens once below via `computeAffectedSchemaContext`.
  const seedIds = new Set<string>();
  for (let i = 0; i < Math.min(changes.length, maxCandidates); i++) {
    try {
      const impact = await computeProjectImpact(changes[i], opts.projectId, {
        mapRequirement,
        dataSourceFor,
        includeSchemaImpact: false,
      });
      for (const s of impact.affectedSymbols) {
        if (s.codeSymbolId) seedIds.add(s.codeSymbolId);
      }
    } catch (err) {
      // One candidate's mapping failure must never sink the run — skip it.
      log.warn("impact mapping failed for candidate; skipping in affected-schema", {
        projectId: opts.projectId,
        error: String(err),
      });
    }
  }
  if (seedIds.size === 0) return EMPTY_AFFECTED_SCHEMA_CONTEXT;

  // Reuse #823's crossing + render + degradation (no parallel machinery).
  return computeAffectedSchemaContext({
    requirementId: opts.projectId,
    affectedSymbolIds: [...seedIds],
    dataSource: schemaDataSourceFor(opts.projectId),
    // #826 — reconcile against the live schema (when available) so the affected
    // rows carry `matched`/`*-not-found`, and link cross-project identities, so
    // the verdict gate can act on real reconciliation. Both default to a no-op.
    liveIndex: opts.deps?.liveIndex ?? null,
    identityResolver: opts.deps?.identityResolver ?? null,
    tokenBudget,
    maxRows,
  });
}
