/**
 * Connector / env-specific row remap for logical import (Item 2).
 *
 * On import into a new environment, connector rows and a handful of
 * topology-coupled RuntimeConfig keys point at the *source* host's
 * infrastructure (URLs, hostnames, ports, file paths). This module computes the
 * corrected values from an operator-supplied, Zod-validated remap spec.
 *
 * Design:
 *   - The spec supports TWO remap mechanisms per target:
 *       1. `valueMap`   — old-value -> new-value substitution applied to the
 *                          relevant field(s), regardless of row id.
 *       2. `byId`       — explicit per-row-id field overrides (highest priority).
 *   - This module is PURE: {@link computeRemap} takes the validated spec + the
 *     current rows and returns the set of changes (no DB access). The thin DB
 *     wrapper that applies the changes inside a transaction lives in the import
 *     CLI.
 *   - Secret VALUES are never logged. Remap only ever touches non-secret
 *     topology fields (hosts, URLs, paths, ports) and env-specific RuntimeConfig
 *     tunables — never the Secret table's ciphertext/iv/tag/salt.
 *
 * Remap targets:
 *   RepoConnection      → apiBaseUrl, localPath, uploadPath
 *   DatabaseConnection  → host, port, databaseName
 *   MCPServer           → url
 *   RuntimeConfig       → only keys classified `env-specific-tunable`
 */

import { z } from "zod";
import { classifyConfigKey } from "./env-config-classifier.js";

// ── Remappable field allowlists (security: nothing else is touchable) ─────────

export const REMAPPABLE_FIELDS = Object.freeze({
  RepoConnection: ["apiBaseUrl", "localPath", "uploadPath"] as const,
  DatabaseConnection: ["host", "port", "databaseName"] as const,
  MCPServer: ["url"] as const,
});

export type RemappableModel = keyof typeof REMAPPABLE_FIELDS;

// ── Zod spec ──────────────────────────────────────────────────────────────────

// A scalar value a remap may write. `port` is numeric; everything else string.
const RemapScalar = z.union([z.string(), z.number().int().nonnegative(), z.null()]);

// Per-model remap: optional value-map per field + optional per-id overrides.
function modelRemapSchema<M extends RemappableModel>(model: M) {
  const fields = REMAPPABLE_FIELDS[model] as readonly string[];
  const fieldEnum = z.enum(fields as [string, ...string[]]);
  return z
    .object({
      // valueMap: field -> { oldValue: newValue }
      valueMap: z.record(fieldEnum, z.record(z.string(), RemapScalar)).optional(),
      // byId: rowId -> { field: newValue }
      byId: z.record(z.string().min(1), z.record(fieldEnum, RemapScalar)).optional(),
    })
    .strict();
}

export const RemapSpecSchema = z
  .object({
    version: z.literal(1),
    RepoConnection: modelRemapSchema("RepoConnection").optional(),
    DatabaseConnection: modelRemapSchema("DatabaseConnection").optional(),
    MCPServer: modelRemapSchema("MCPServer").optional(),
    // RuntimeConfig is keyed by config KEY (not row id). Only env-specific
    // tunable keys are permitted; validated by superRefine below.
    RuntimeConfig: z
      .object({
        // key -> new value
        set: z.record(z.string().min(1), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (!spec.RuntimeConfig?.set) return;
    for (const key of Object.keys(spec.RuntimeConfig.set)) {
      let cls: string;
      try {
        cls = classifyConfigKey(key);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `RuntimeConfig remap references unknown config key "${key}".`,
          path: ["RuntimeConfig", "set", key],
        });
        continue;
      }
      if (cls !== "env-specific-tunable") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `RuntimeConfig remap key "${key}" is classified "${cls}", not ` +
            `"env-specific-tunable". Only topology-coupled tunables may be remapped ` +
            `(secrets and bootstrap keys must be provisioned out-of-band).`,
          path: ["RuntimeConfig", "set", key],
        });
      }
    }
  });

export type RemapSpec = z.infer<typeof RemapSpecSchema>;

export class RemapValidationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RemapValidationError";
  }
}

/** Parse + validate an unknown value as a {@link RemapSpec}. */
export function parseRemapSpec(raw: unknown): RemapSpec {
  const result = RemapSpecSchema.safeParse(raw);
  if (!result.success) {
    throw new RemapValidationError(`Invalid remap spec: ${result.error.message}`, result.error);
  }
  return result.data;
}

// ── Pure transform ──────────────────────────────────────────────────────────

export interface FieldChange {
  rowId: string;
  field: string;
  before: unknown;
  after: unknown;
}

export interface ModelRemapResult {
  model: string;
  changes: FieldChange[];
}

/** A minimal row shape: must have an `id` plus the remappable fields. */
export type RemapRow = Record<string, unknown> & { id: string };

/**
 * Compute the field changes a model-level remap would apply, WITHOUT mutating
 * the input rows. `byId` overrides win over `valueMap`. Only fields whose value
 * actually changes are reported.
 */
export function computeModelRemap(
  model: RemappableModel,
  rows: RemapRow[],
  remap: {
    valueMap?: Record<string, Record<string, unknown>>;
    byId?: Record<string, Record<string, unknown>>;
  },
): ModelRemapResult {
  const changes: FieldChange[] = [];
  const allowed = new Set<string>(REMAPPABLE_FIELDS[model]);

  for (const row of rows) {
    const id = row.id;
    const override = remap.byId?.[id];

    for (const field of allowed) {
      const before = row[field];
      let after: unknown = before;

      // 1) valueMap substitution (old -> new) keyed on the current value.
      const fieldMap = remap.valueMap?.[field];
      if (fieldMap && before !== null && before !== undefined) {
        const key = String(before);
        if (Object.prototype.hasOwnProperty.call(fieldMap, key)) {
          after = fieldMap[key];
        }
      }

      // 2) per-id override (highest priority).
      if (override && Object.prototype.hasOwnProperty.call(override, field)) {
        after = override[field];
      }

      if (!valuesEqual(before, after)) {
        changes.push({ rowId: id, field, before, after });
      }
    }
  }

  return { model, changes };
}

export interface RuntimeConfigChange {
  key: string;
  before: string | null;
  after: string;
}

/**
 * Compute RuntimeConfig key changes. `currentValues` maps key -> current value
 * (null if the row is absent). Only keys present in `set` are considered; the
 * caller has already validated all keys are env-specific tunables.
 */
export function computeRuntimeConfigRemap(
  set: Record<string, string>,
  currentValues: Record<string, string | null>,
): RuntimeConfigChange[] {
  const changes: RuntimeConfigChange[] = [];
  for (const [key, after] of Object.entries(set)) {
    const before = currentValues[key] ?? null;
    if (before !== after) changes.push({ key, before, after });
  }
  return changes;
}

export interface RemapPlan {
  models: ModelRemapResult[];
  runtimeConfig: RuntimeConfigChange[];
}

/**
 * Build the full remap plan from a validated spec + the relevant current rows.
 * Pure — returns the changes; the import CLI applies them inside a transaction.
 */
export function computeRemap(
  spec: RemapSpec,
  data: {
    RepoConnection?: RemapRow[];
    DatabaseConnection?: RemapRow[];
    MCPServer?: RemapRow[];
    runtimeConfigValues?: Record<string, string | null>;
  },
): RemapPlan {
  const models: ModelRemapResult[] = [];

  for (const model of ["RepoConnection", "DatabaseConnection", "MCPServer"] as const) {
    const remap = spec[model];
    const rows = data[model];
    if (remap && rows && rows.length > 0) {
      const result = computeModelRemap(model, rows, remap);
      if (result.changes.length > 0) models.push(result);
    }
  }

  let runtimeConfig: RuntimeConfigChange[] = [];
  if (spec.RuntimeConfig?.set) {
    runtimeConfig = computeRuntimeConfigRemap(
      spec.RuntimeConfig.set,
      data.runtimeConfigValues ?? {},
    );
  }

  return { models, runtimeConfig };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  // Strict equality intentionally treats a number-vs-string mismatch as a CHANGE
  // (e.g. DatabaseConnection.port: stored as 5432 vs. a remap supplying "5432").
  // This is asymmetric on purpose: the spec's `port` is `z.number()`, so a
  // numeric remap value never equals a string-typed stored value, and the remap
  // applies — which is the desired behavior (it normalizes the column to the
  // spec's numeric type). null/undefined are treated as equivalent so a no-op
  // null→null is not reported as a change.
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  return false;
}
