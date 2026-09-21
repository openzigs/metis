/**
 * Manual schema-usage overrides — Epic #294 (#304).
 *
 * The SQL-lineage sidecar (#303) resolves most embedded SQL, but dynamic SQL
 * (runtime-built query strings, reflection, EXEC of a variable) is inherently
 * unresolvable by static analysis — it surfaces as `uncertain`. This module lets
 * an analyst ASSERT or CORRECT a usage edge the parser cannot derive, persisting
 * it with `source = "manual"`. Manual overrides take PRECEDENCE over derived
 * classifications (see `SCHEMA_SOURCE_PRECEDENCE` in @metis/shared).
 *
 * Two responsibilities:
 *   1. CRUD the override rows (upsert by project+table+column+access, list, delete).
 *   2. {@link applyOverrides} — fold the persisted overrides INTO the derived
 *      usage-classification view so the impact UI/doc shows the corrected class
 *      with `overriddenClass` set. Pure merge; the derived rows are never mutated
 *      on disk.
 *
 * Security/safety: NO DDL, NO live queries. All reads/writes are scoped to a
 * single `projectId`; the route asserts the actor may access that project. A
 * manual override NEVER triggers an auto-drop — it only changes how an object is
 * classified for review/impact.
 */
import type { PrismaClient } from "@prisma/client";
import type {
  ManualUsageOverrideInput,
  ManualUsageOverrideView,
  SchemaObjectEdgeKind,
  SchemaUsageClassificationView,
  UsageClass,
  UsageObjectKind,
} from "@metis/shared";
import { normalizeIdentifier } from "../code-graph/schema-graph.js";

type OverrideDelegate = PrismaClient["schemaUsageOverride"];

interface OverridePrisma {
  // We use findFirst + create/update rather than `upsert` keyed on the compound
  // unique because the unique includes the NULLABLE `columnName`: Prisma's
  // generated compound-unique `where` cannot match a NULL column (a known
  // limitation), and a table-level override has columnName = null. find-first
  // (scoped to the project) sidesteps that and stays sqlite/postgres-portable.
  schemaUsageOverride: Pick<
    OverrideDelegate,
    "findFirst" | "create" | "update" | "findMany" | "deleteMany"
  >;
}

/** Persisted row shape (loose — the generated delegate satisfies it structurally). */
interface OverrideRow {
  id: string;
  projectId: string;
  kind: string;
  tableName: string;
  columnName: string | null;
  usageClass: string;
  access: string;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
}

function toView(row: OverrideRow): ManualUsageOverrideView {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as UsageObjectKind,
    tableName: row.tableName,
    columnName: row.columnName,
    usageClass: row.usageClass as UsageClass,
    access: row.access as SchemaObjectEdgeKind,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Normalize the override target identity the same way the schema graph does. */
function normalizeTarget(input: ManualUsageOverrideInput): {
  tableName: string;
  columnName: string | null;
} {
  return {
    tableName: normalizeIdentifier(input.tableName),
    columnName: input.columnName ? normalizeIdentifier(input.columnName) : null,
  };
}

/**
 * Create or update a manual override (idempotent per project+table+column+access).
 * Re-asserting the same target updates the class/note in place rather than
 * duplicating. Returns the persisted view.
 */
export async function upsertManualOverride(
  prisma: OverridePrisma,
  projectId: string,
  input: ManualUsageOverrideInput,
  actorId: string | null,
): Promise<ManualUsageOverrideView> {
  const { tableName, columnName } = normalizeTarget(input);
  const access = input.access ?? "reads";
  const existing = (await prisma.schemaUsageOverride.findFirst({
    where: { projectId, tableName, columnName, access },
    select: { id: true },
  })) as { id: string } | null;

  let row: OverrideRow;
  if (existing) {
    row = (await prisma.schemaUsageOverride.update({
      where: { id: existing.id },
      data: {
        kind: input.kind,
        usageClass: input.usageClass,
        note: input.note ?? null,
        createdBy: actorId,
      },
    })) as OverrideRow;
  } else {
    row = (await prisma.schemaUsageOverride.create({
      data: {
        projectId,
        kind: input.kind,
        tableName,
        columnName,
        usageClass: input.usageClass,
        access,
        note: input.note ?? null,
        createdBy: actorId,
      },
    })) as OverrideRow;
  }
  return toView(row);
}

/** List a project's manual overrides (scoped to the project). */
export async function listManualOverrides(
  prisma: OverridePrisma,
  projectId: string,
): Promise<ManualUsageOverrideView[]> {
  const rows = (await prisma.schemaUsageOverride.findMany({
    where: { projectId },
    orderBy: [{ tableName: "asc" }, { columnName: "asc" }],
  })) as OverrideRow[];
  return rows.map(toView);
}

/**
 * Delete a manual override by id, scoped to the project (so a caller cannot
 * delete another tenant's row by guessing an id). Returns true when a row was
 * removed.
 */
export async function deleteManualOverride(
  prisma: OverridePrisma,
  projectId: string,
  id: string,
): Promise<boolean> {
  const res = await prisma.schemaUsageOverride.deleteMany({ where: { id, projectId } });
  return res.count > 0;
}

/** Join key for matching an override to a classification row. */
function targetKey(tableName: string, columnName: string | null): string {
  return `${normalizeIdentifier(tableName)}::${columnName ? normalizeIdentifier(columnName) : ""}`;
}

/**
 * Fold manual overrides into the derived classification view (precedence: manual
 * wins). For each classification row that a manual override targets, set
 * `usageClass` to the asserted class and record the prior derived class in
 * `overriddenClass`. Overrides that target an object NOT present in the derived
 * set are appended as synthetic rows (an analyst asserting usage for an object the
 * static pass never saw — e.g. reached only via dynamic SQL).
 *
 * Pure function — does not touch the database.
 */
export function applyOverrides(
  classifications: SchemaUsageClassificationView[],
  overrides: ManualUsageOverrideView[],
): SchemaUsageClassificationView[] {
  if (overrides.length === 0) return classifications;
  const byTarget = new Map<string, ManualUsageOverrideView>();
  for (const o of overrides) {
    // First override per target wins (list is deterministically ordered).
    const key = targetKey(o.tableName, o.columnName);
    if (!byTarget.has(key)) byTarget.set(key, o);
  }

  const applied = new Set<string>();
  const merged = classifications.map((row) => {
    const key = targetKey(row.tableName, row.columnName);
    const override = byTarget.get(key);
    if (!override) return row;
    applied.add(key);
    // No-op when the override matches the already-derived class.
    if (override.usageClass === row.usageClass && row.overriddenClass === null) {
      return { ...row, overriddenClass: row.usageClass };
    }
    return {
      ...row,
      usageClass: override.usageClass,
      // Preserve the originally-derived class for the UI provenance badge.
      overriddenClass: row.usageClass,
    };
  });

  // Append overrides that matched no derived row (asserting a brand-new object).
  for (const [key, override] of byTarget) {
    if (applied.has(key)) continue;
    merged.push({
      id: `override:${override.id}`,
      projectId: override.projectId,
      kind: override.kind,
      tableName: override.tableName,
      columnName: override.columnName,
      columnType: null,
      usageClass: override.usageClass,
      uncertainReason: null,
      evidence: [],
      // No derived class existed; record null prior class but flag the manual class.
      overriddenClass: override.usageClass,
      computedAt: override.createdAt,
    });
  }

  return merged;
}
