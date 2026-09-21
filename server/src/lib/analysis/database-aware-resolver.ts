/**
 * Database-aware analysis RESOLVER — Epic #852 Phase 2a (#854).
 *
 * A single, pure function that collapses the per-project
 * `Project.databaseAwareAnalysis` setting (#853), the two legacy platform env
 * flags, and a "does this project have schema data" signal into ONE resolved
 * decision + a machine-readable reason. Both the run path (`computeRunAffectedSchemaContext`,
 * wired in #855) and the gap-report path (`resolveGapReportDeps`, wired in
 * #856) will call THIS function so they can no longer diverge into a
 * half-on state — the exact failure mode #852 exists to close.
 *
 * {@link resolveDatabaseAwareAnalysis} itself is deliberately kept pure and
 * dependency-free: no Prisma, no config service, no I/O. The caller is
 * responsible for:
 *   - reading `Project.databaseAwareAnalysis` (validated against the shared
 *     whitelist, `packages/shared/src/schema-impact.ts`),
 *   - reading the two platform flags via {@link readDbAwareEnvDefault} (which
 *     also records whether an operator EXPLICITLY set them — #849),
 *   - probing whether the project has schema data (a connected
 *     `DatabaseConnection` OR a non-empty schema graph — table/column
 *     `CodeSymbol` rows + `reads`/`writes`/`persists-to` `CodeEdge` rows in
 *     `code_symbols`/`code_edges`). {@link hasSchemaData} is the presence
 *     helper #854's acceptance criteria calls for — it takes an INJECTED
 *     Prisma-shaped client (see {@link SchemaDataPrismaClient}) rather than a
 *     module-level import, so the resolver above stays pure while #855/#856
 *     can reuse this helper with whatever already-scoped client/transaction
 *     they run under instead of hand-rolling the same two counts.
 *     {@link combineHasSchemaData} is the pure OR combinator both
 *     {@link hasSchemaData} and any caller with its own two booleans can use.
 *
 * ---------------------------------------------------------------------------
 * DESIGN DECISION — platform flags vs. per-project setting precedence
 * ---------------------------------------------------------------------------
 * REVISED AGAIN in #849 (epic #820's "flip it on" follow-up). #854's ruling
 * that `auto` must not be defeated by a never-configured operator still
 * stands; what changes is that "never configured" and "explicitly configured
 * false" are no longer conflated. `ConfigService.describeSource(key)`
 * (`server/src/lib/config/config-service.ts`) reports `vault`/`db`/`env`/
 * `unset` per key, so the two legacy flags CAN now express an explicit
 * operator "force this off" — the exact bit pattern #854 said did not exist.
 * See {@link readDbAwareEnvDefault}.
 *
 * Resolution order (highest precedence first):
 *
 *   1. Per-project `on`/`off` — an EXPLICIT analyst intent, never
 *      second-guessed by platform state:
 *        - `off` is unconditionally disabled, regardless of platform flags or
 *          schema data.
 *        - `on` is unconditionally enabled and ALWAYS reachable without an
 *          operator touching any env var (#851 intent #2). `on` with no schema
 *          data still reports `enabled=true, ran=false,
 *          reason=skipped-no-schema-data` so the UI shows a "connect a
 *          database or re-ingest" hint instead of silently no-op'ing.
 *
 *   2. An EXPLICITLY CONFIGURED platform flag, on the `auto` path only. If an
 *      operator actually set `ANALYSIS_AFFECTED_SCHEMA_MAPPING` /
 *      `ANALYSIS_SCHEMA_IMPACT` (source `db` or `env` — both keys are
 *      `tier: "tunable"`, so an operator-set value can arrive from EITHER) and
 *      every flag they set is false, that is a deliberate fleet-wide
 *      kill-switch: `auto` resolves `enabled=false, reason=auto->platform-disabled`
 *      WITHOUT consulting schema data. Explicitly setting either flag true is
 *      an opt-in and does not suppress anything. This is what restores the
 *      backward compatibility #854 knowingly broke: before #849 an operator's
 *      `ANALYSIS_SCHEMA_IMPACT=0` was silently overridden with no fleet-wide
 *      opt-out at all.
 *
 *   3. Otherwise (nothing explicitly configured) the platform default is now
 *      ON — {@link DB_AWARE_PLATFORM_DEFAULT} — and `auto` depends ONLY on
 *      schema-data presence, exactly as #854 specified: `hasSchemaData=true`
 *      resolves `auto->resolved-on`, `hasSchemaData=false` resolves
 *      `auto->resolved-off-no-data`. This is the #849 flip: a project with no
 *      setting on a deployment with no explicit flag now gets database-aware
 *      analysis, instead of needing hidden env config first.
 *
 * Note the deliberate asymmetry in step 1 vs. step 2: the platform flag is the
 * DEFAULT for `auto`, not a hard master switch — a per-project explicit `on`
 * still wins over a platform kill-switch. That mirrors `Project.sqlLineage`'s
 * resolver (`server/src/lib/code-graph/sql-lineage-resolver.ts`, #894), where
 * `on`/`off` are likewise "always reachable regardless of the platform env
 * flag". Database-aware analysis issues NO paid LLM calls of its own (the
 * crossing is deterministic graph traversal; it only enriches prompts that
 * were already going to be sent), so a per-project opt-in cannot blow up an
 * operator's spend the way flipping an LLM-gated flag would.
 * ---------------------------------------------------------------------------
 *
 * OWASP / defensive posture: `setting` is treated as untrusted (it round-trips
 * through a DB column that predates this resolver and could in principle hold
 * a stale/corrupted value). An unrecognized value NEVER throws into the
 * analysis run — it falls back to the validated default (`auto`) semantics,
 * matching `DEFAULT_DATABASE_AWARE_ANALYSIS_SETTING` in
 * `packages/shared/src/schema-impact.ts`.
 */
import type { DatabaseAwareAnalysisSetting } from "@metis/shared";

/**
 * The two platform flags this resolver folds into the `auto` platform-default
 * check. Named to match the config keys 1:1:
 *   - `affectedSchemaMapping` <- `ANALYSIS_AFFECTED_SCHEMA_MAPPING`
 *     (`server/src/lib/analysis/affected-schema-context.ts`).
 *   - `schemaImpact` <- `ANALYSIS_SCHEMA_IMPACT`
 *     (`server/src/lib/analysis/schema-impact-producer.ts`).
 *
 * The `*Explicit` companions (#849) say whether an OPERATOR actually set that
 * key (`describeSource(key).source !== "unset"`), as opposed to it merely
 * carrying {@link DB_AWARE_PLATFORM_DEFAULT}. They are optional so pre-#849
 * callers keep compiling and keep their behaviour: absent ⇒ "never configured"
 * ⇒ the default-ON path. Build them with {@link readDbAwareEnvDefault} rather
 * than by hand.
 */
export interface DbAwareEnvDefault {
  affectedSchemaMapping: boolean;
  schemaImpact: boolean;
  /** Whether an operator explicitly configured `ANALYSIS_AFFECTED_SCHEMA_MAPPING`. */
  affectedSchemaMappingExplicit?: boolean;
  /** Whether an operator explicitly configured `ANALYSIS_SCHEMA_IMPACT`. */
  schemaImpactExplicit?: boolean;
}

/**
 * Machine-readable reason the resolver arrived at its decision — surfaced to
 * analysis metadata (#855), the gap report (#856), and the UI (#858/#859) so
 * "why did/didn't this run" is always observable, never a silent no-op.
 *
 * `auto->platform-disabled` (#849) is named to match the identical member of
 * `SQL_LINEAGE_REASONS` (`packages/shared/src/schema-impact.ts`) — one reason
 * vocabulary for "the operator turned this off platform-wide" across both
 * per-project resolvers. Keep this union in sync with
 * `AnalysisDatabaseAwareReason` (`packages/shared/src/analysis.ts`).
 */
export type DbAwareReason =
  | "off"
  | "auto->resolved-on"
  | "auto->resolved-off-no-data"
  | "auto->platform-disabled"
  | "on"
  | "skipped-no-schema-data";

export interface ResolveDatabaseAwareAnalysisInput {
  /** `Project.databaseAwareAnalysis` — treated as untrusted, see module docs. */
  setting: DatabaseAwareAnalysisSetting;
  /** The two legacy platform env flags, read by the caller via `cfg.getBool`. */
  envDefault: DbAwareEnvDefault;
  /**
   * Whether this project has schema data to act on: a connected
   * `DatabaseConnection` OR a non-empty schema graph. Probed by the caller
   * (#855/#856); see {@link combineHasSchemaData}.
   */
  hasSchemaData: boolean;
}

export interface ResolveDatabaseAwareAnalysisResult {
  /** Whether database-aware analysis is enabled for this project/run. */
  enabled: boolean;
  /**
   * Whether it actually RAN (crossed impacted code/requirements into the
   * schema graph). Distinct from `enabled`: an explicit `on` project with no
   * schema data is `enabled=true, ran=false` — surfaced as a hint, never a
   * silent off.
   */
  ran: boolean;
  /** Machine-readable reason; see {@link DbAwareReason}. */
  reason: DbAwareReason;
}

/**
 * Pure OR of the two schema-data presence signals the epic's design intent
 * names explicitly: a connected `DatabaseConnection` and a non-empty schema
 * graph (table/column symbols + persists-to/reads/writes edges). Exists so
 * callers (#855/#856) don't hand-roll the boolean combination; the actual
 * Prisma/graph probing that PRODUCES these two booleans is out of scope here.
 */
export function combineHasSchemaData(
  hasDbConnection: boolean,
  hasNonEmptySchemaGraph: boolean,
): boolean {
  return hasDbConnection || hasNonEmptySchemaGraph;
}

/** `CodeSymbol.kind` values that make up the schema graph (Epic #168). */
const SCHEMA_GRAPH_SYMBOL_KINDS = ["table", "column"] as const;
/** `CodeEdge.kind` values that make up the schema graph (Epic #168). */
const SCHEMA_GRAPH_EDGE_KINDS = ["reads", "writes", "persists-to"] as const;

/**
 * Minimal Prisma-shaped surface {@link hasSchemaData} needs — deliberately a
 * hand-written structural type (not `import type { PrismaClient }`) so this
 * module still takes no hard dependency on `@prisma/client`/`../prisma.js`.
 * Callers (#855/#856) pass their own already-scoped Prisma client/tx.
 */
export interface SchemaDataPrismaClient {
  databaseConnection: {
    count(args: {
      where: { projectId: string; deletedAt: null; status: "connected" };
    }): Promise<number>;
  };
  codeSymbol: {
    count(args: { where: { projectId: string; kind: { in: readonly string[] } } }): Promise<number>;
  };
  codeEdge: {
    count(args: { where: { projectId: string; kind: { in: readonly string[] } } }): Promise<number>;
  };
}

/**
 * `hasSchemaData(projectId)` — the presence helper #854's acceptance
 * criteria calls for: "checks BOTH a live `DatabaseConnection` and a
 * non-empty schema graph; read-only, no DDL." Takes an INJECTED Prisma-shaped
 * client rather than importing the module-level singleton, so:
 *   - {@link resolveDatabaseAwareAnalysis} above stays pure/dependency-free,
 *   - this helper is unit-testable with a plain fake object (no `vi.mock`
 *     of `../prisma.js` needed),
 *   - #855/#856 can pass whatever already-scoped client/transaction they use
 *     in the run path / gap-report path instead of a second DB round trip.
 *
 * Read-only `count()` queries only — never issues DDL, never opens a live
 * connection to a CUSTOMER database (this only reads METIS's own
 * `database_connections`/`code_symbols`/`code_edges` tables).
 */
export async function hasSchemaData(
  prisma: SchemaDataPrismaClient,
  projectId: string,
): Promise<boolean> {
  const [dbConnectionCount, symbolCount, edgeCount] = await Promise.all([
    prisma.databaseConnection.count({
      where: { projectId, deletedAt: null, status: "connected" },
    }),
    prisma.codeSymbol.count({
      where: { projectId, kind: { in: SCHEMA_GRAPH_SYMBOL_KINDS } },
    }),
    prisma.codeEdge.count({
      where: { projectId, kind: { in: SCHEMA_GRAPH_EDGE_KINDS } },
    }),
  ]);
  return combineHasSchemaData(dbConnectionCount > 0, symbolCount > 0 || edgeCount > 0);
}

/** The two platform config keys, in one place so no caller re-types them. */
export const DB_AWARE_PLATFORM_FLAG_KEYS = {
  affectedSchemaMapping: "ANALYSIS_AFFECTED_SCHEMA_MAPPING",
  schemaImpact: "ANALYSIS_SCHEMA_IMPACT",
} as const;

/**
 * The platform default for both flags — ON since #849. Every `cfg.getBool`
 * call for these two keys MUST pass this constant rather than a literal, so
 * the default can never drift between the run path, the gap-report path, and
 * the legacy fallback in `computeRunAffectedSchemaContext`.
 */
export const DB_AWARE_PLATFORM_DEFAULT = true;

/**
 * The slice of `ConfigService` {@link readDbAwareEnvDefault} needs — a
 * structural type, so this module still imports no config service (and a test
 * can pass a two-method object). `describeSource` is optional because partial
 * config-service doubles are an established pattern in this repo's tests.
 */
export interface DbAwareConfigReader {
  getBool(key: string, defaultValue?: boolean): boolean;
  describeSource?(key: string): { source: "vault" | "db" | "env" | "unset" };
}

/**
 * Whether an operator EXPLICITLY configured `key`, as opposed to it falling
 * back to the registry/platform default. Both database-aware keys are
 * `tier: "tunable"`, so an operator-set value surfaces as source `"db"` (admin
 * UI / DB-backed tunable) OR `"env"` (deployment env var) — both count.
 *
 * Never throws: `describeSource` raises `ConfigUnknownKeyError` for an
 * unregistered key, and this resolver's contract is that no config read can
 * throw into an analysis run. An unreadable source degrades to "not explicitly
 * configured", i.e. the default-ON path.
 */
export function isPlatformFlagExplicit(cfg: DbAwareConfigReader, key: string): boolean {
  try {
    const info = cfg.describeSource?.(key);
    return info !== undefined && info.source !== "unset";
  } catch {
    return false;
  }
}

/**
 * Read both platform flags plus their explicit-configuration status off a
 * config service. The ONE place the `getBool` defaults and the
 * `describeSource` probes live, so the run path (`orchestrator.ts`) and the
 * gap-report path (`schema-impact-producer.ts`) cannot drift apart.
 */
export function readDbAwareEnvDefault(cfg: DbAwareConfigReader): DbAwareEnvDefault {
  const { affectedSchemaMapping, schemaImpact } = DB_AWARE_PLATFORM_FLAG_KEYS;
  return {
    affectedSchemaMapping: cfg.getBool(affectedSchemaMapping, DB_AWARE_PLATFORM_DEFAULT),
    schemaImpact: cfg.getBool(schemaImpact, DB_AWARE_PLATFORM_DEFAULT),
    affectedSchemaMappingExplicit: isPlatformFlagExplicit(cfg, affectedSchemaMapping),
    schemaImpactExplicit: isPlatformFlagExplicit(cfg, schemaImpact),
  };
}

/**
 * The operator kill-switch test (#849, step 2 of the module's resolution
 * order): true when at least one platform flag was EXPLICITLY configured and
 * none of the explicitly configured ones is true.
 *
 * Explicitly turning either flag ON is an opt-in and never suppresses, so a
 * mixed `MAPPING=1, SCHEMA_IMPACT=0` deployment resolves ON — the resolver
 * yields ONE decision for both paths, so any explicit opt-in wins over a
 * partial opt-out. Flags left untouched are ignored entirely: they carry the
 * default, and a default can't be a deliberate "off".
 */
function isPlatformExplicitlyDisabled(envDefault: DbAwareEnvDefault | undefined): boolean {
  const explicitValues = [
    envDefault?.affectedSchemaMappingExplicit === true
      ? envDefault.affectedSchemaMapping === true
      : undefined,
    envDefault?.schemaImpactExplicit === true ? envDefault.schemaImpact === true : undefined,
  ].filter((v): v is boolean => v !== undefined);

  return explicitValues.length > 0 && explicitValues.every((enabled) => !enabled);
}

/** The whitelist this resolver treats as valid `setting` values. */
const VALID_SETTINGS: ReadonlySet<DatabaseAwareAnalysisSetting> = new Set(["auto", "on", "off"]);

/**
 * Resolve the effective database-aware-analysis decision for a single
 * project/run. See the module-level DESIGN DECISION block for the precedence
 * reasoning. Never throws — an unrecognized `setting` degrades to `auto`
 * semantics (OWASP: fail to the validated default, not open).
 */
export function resolveDatabaseAwareAnalysis(
  input: ResolveDatabaseAwareAnalysisInput | null | undefined,
): ResolveDatabaseAwareAnalysisResult {
  // Defensive: a null/undefined input must never throw (same "never throw
  // into the analysis run" posture as the unrecognized-`setting` fallback
  // below) — coerce to a safe default shape before destructuring.
  const safeInput: Partial<ResolveDatabaseAwareAnalysisInput> = input ?? {};
  const setting: DatabaseAwareAnalysisSetting = VALID_SETTINGS.has(
    safeInput?.setting as DatabaseAwareAnalysisSetting,
  )
    ? (safeInput.setting as DatabaseAwareAnalysisSetting)
    : "auto";
  const hasSchemaData = Boolean(safeInput.hasSchemaData);

  if (setting === "off") {
    return { enabled: false, ran: false, reason: "off" };
  }

  if (setting === "on") {
    return hasSchemaData
      ? { enabled: true, ran: true, reason: "on" }
      : { enabled: true, ran: false, reason: "skipped-no-schema-data" };
  }

  // setting === "auto" — an explicit operator kill-switch outranks the
  // default-ON platform behaviour (#849 step 2). Checked BEFORE schema data so
  // the reported reason names the actual cause (the operator's config), not a
  // data gap that was never consulted.
  if (isPlatformExplicitlyDisabled(safeInput.envDefault)) {
    return { enabled: false, ran: false, reason: "auto->platform-disabled" };
  }

  // Nothing explicitly configured (#849 step 3): the platform default is ON,
  // so `auto` depends ONLY on schema-data presence — #851 intent #1. A
  // never-configured operator can no longer suppress every project's `auto`.
  return hasSchemaData
    ? { enabled: true, ran: true, reason: "auto->resolved-on" }
    : { enabled: false, ran: false, reason: "auto->resolved-off-no-data" };
}
