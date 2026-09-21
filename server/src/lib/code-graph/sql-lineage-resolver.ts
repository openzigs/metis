/**
 * Per-project SQL-lineage resolver — Epic #882 Phase 3 (#894).
 *
 * Mirrors `server/src/lib/analysis/database-aware-resolver.ts` (#852/#854):
 * a single, pure function that collapses the per-project `Project.sqlLineage`
 * setting with the platform default (`isSqlLineageEnabled()` /
 * `SQL_LINEAGE_MODE`) into ONE resolved decision + a machine-readable reason.
 * {@link resolveSqlLineage} is deliberately pure/dependency-free (no Prisma,
 * no I/O) so it stays trivially unit-testable; {@link resolveProjectSqlLineage}
 * is the thin async wrapper that reads `Project.sqlLineage` via an injected
 * Prisma-shaped client and folds in the platform default.
 *
 * Precedence (simpler than the database-aware resolver's `auto` — there is no
 * equivalent "does this project have data" signal for SQL lineage, only
 * whether the sidecar path is configured):
 *   - `off` — unconditional per-project override: ALWAYS disabled, regardless
 *     of the platform env flag.
 *   - `on` — unconditional per-project override in the other direction:
 *     ALWAYS enabled, even when the platform default is off. Extraction still
 *     degrades gracefully (never throws into ingest) when the sidecar itself
 *     is unreachable/unconfigured — see `extractUsageSafe` in
 *     `sql-lineage-client.ts`.
 *   - `auto` (default) — defers to the platform default
 *     (`isSqlLineageEnabled()` / `SQL_LINEAGE_MODE`), so a project that never
 *     touches this setting behaves EXACTLY as it did pre-#894 (the "without
 *     breaking existing global behavior" acceptance criterion).
 *
 * OWASP / defensive posture: `setting` is treated as untrusted (round-trips
 * through a DB column) — an unrecognized value never throws, it degrades to
 * the validated `auto` default.
 */
import {
  SQL_LINEAGE_SETTINGS,
  DEFAULT_SQL_LINEAGE_SETTING,
  type SqlLineageSetting,
} from "@metis/shared";
import { isSqlLineageEnabled } from "./sql-lineage-client.js";

export type SqlLineageReason = "off" | "on" | "auto->platform-enabled" | "auto->platform-disabled";

export interface ResolveSqlLineageInput {
  /** `Project.sqlLineage` — treated as untrusted, see module docs. */
  setting: SqlLineageSetting;
  /** The platform default (`isSqlLineageEnabled()` with no override). */
  platformEnabled: boolean;
}

export interface ResolveSqlLineageResult {
  /** Whether the non-ORM SQL-lineage extraction pass is enabled for this project. */
  enabled: boolean;
  /** Machine-readable reason; see {@link SqlLineageReason}. */
  reason: SqlLineageReason;
}

const VALID_SETTINGS: ReadonlySet<SqlLineageSetting> = new Set(SQL_LINEAGE_SETTINGS);

/**
 * Resolve the effective SQL-lineage decision for a single project. Never
 * throws — an unrecognized `setting` (or a null/undefined input) degrades to
 * `auto` semantics.
 */
export function resolveSqlLineage(
  input: ResolveSqlLineageInput | null | undefined,
): ResolveSqlLineageResult {
  const safeInput: Partial<ResolveSqlLineageInput> = input ?? {};
  const setting: SqlLineageSetting = VALID_SETTINGS.has(safeInput.setting as SqlLineageSetting)
    ? (safeInput.setting as SqlLineageSetting)
    : DEFAULT_SQL_LINEAGE_SETTING;
  const platformEnabled = Boolean(safeInput.platformEnabled);

  if (setting === "off") return { enabled: false, reason: "off" };
  if (setting === "on") return { enabled: true, reason: "on" };

  return platformEnabled
    ? { enabled: true, reason: "auto->platform-enabled" }
    : { enabled: false, reason: "auto->platform-disabled" };
}

/** Minimal Prisma-shaped surface {@link resolveProjectSqlLineage} needs. */
export interface SqlLineageProjectPrismaClient {
  project: {
    findUnique(args: {
      where: { id: string };
      select: { sqlLineage: true };
    }): Promise<{ sqlLineage: string } | null>;
  };
}

/**
 * Read `Project.sqlLineage` (validated against the whitelist, degrading to
 * `auto` for an unrecognized/missing value) and fold it with the platform
 * default into one resolved decision. Read-only single `findUnique`; never
 * throws — a lookup failure degrades to the `auto` default (fail to the
 * validated default, not open).
 */
export async function resolveProjectSqlLineage(
  projectId: string,
  prisma: SqlLineageProjectPrismaClient,
): Promise<{ setting: SqlLineageSetting } & ResolveSqlLineageResult> {
  let raw: string | undefined;
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { sqlLineage: true },
    });
    raw = project?.sqlLineage ?? undefined;
  } catch {
    raw = undefined;
  }
  const setting: SqlLineageSetting = VALID_SETTINGS.has(raw as SqlLineageSetting)
    ? (raw as SqlLineageSetting)
    : DEFAULT_SQL_LINEAGE_SETTING;
  const resolved = resolveSqlLineage({ setting, platformEnabled: isSqlLineageEnabled() });
  return { setting, ...resolved };
}
