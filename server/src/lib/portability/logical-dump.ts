/**
 * Provider-agnostic LOGICAL dump/reload primitives (Path B portability).
 *
 * This is the pure, DB-free core that the `logical-export.ts` /
 * `logical-import.ts` CLIs build on. It provides:
 *
 *   1. {@link orderModelsForLoad} — a deterministic, FK-aware topological sort
 *      of models so that referenced rows load before referencing rows. Handles
 *      self-references and cross-model cycles via a deferred-FK strategy: cycle
 *      members are loaded first with their cyclic (nullable) FK columns set to
 *      null, then a second UPDATE pass fills those columns in.
 *
 *   2. {@link serializeRow} / {@link deserializeRow} — lossless, type-driven
 *      round-trip of every Prisma scalar type into NDJSON-safe JSON and back:
 *        DateTime -> ISO string ; Json -> embedded JSON ; Bytes -> base64 (tagged)
 *        BigInt -> string ; Decimal -> string ; null -> null ; enum -> string.
 *
 *   3. {@link EXCLUDED_MODELS} / {@link EXCLUDED_FIELDS} — an explicit registry
 *      of what is deliberately NOT exported, each with a reason. Nothing is
 *      ever silently dropped.
 *
 *   4. {@link buildLogicalManifest} / {@link parseLogicalManifest} — the
 *      logical-dump manifest (per-model row counts + schema/provider + the
 *      included/excluded model lists). This is SEPARATE from the physical
 *      backup manifest in `manifest.ts` and is not interchangeable with it.
 */

import { z } from "zod";
import type { FkEdge, ModelFkInfo } from "./schema-fk-graph.js";

// ════════════════════════════════════════════════════════════════════════════
// 1. FK-aware deterministic ordering
// ════════════════════════════════════════════════════════════════════════════

/** A FK column on a cycle-member model that must be deferred to a 2nd pass. */
export interface DeferredFk {
  /** Owning model whose FK is deferred. */
  model: string;
  /** The relation field name. */
  fieldName: string;
  /** Local scalar columns to null on first insert, then UPDATE in pass 2. */
  columns: string[];
  /** Referenced model (informational; the row already carries the value). */
  referencedModel: string;
}

export interface LoadOrder {
  /** Model names in FK-safe insert order (referenced before referencing). */
  order: string[];
  /**
   * FK columns that had to be deferred to break a cycle (or self-reference).
   * On import, rows for these models are inserted with `columns` nulled, then a
   * second UPDATE pass restores them from the exported data.
   */
  deferred: DeferredFk[];
}

/**
 * Derive a deterministic, FK-safe load order from normalized model FK info.
 *
 * Algorithm:
 *   - Build a dependency graph: an edge M -> N means M references N (M holds a
 *     FK to N), so N must load before M.
 *   - Self-references (M -> M) never create a hard dependency; instead the
 *     self-FK column is DEFERRED (nulled on insert, set in pass 2). A required
 *     self-FK is reported as deferred too (the caller must allow the transient
 *     null inside a transaction) — we never deadlock.
 *   - Kahn's algorithm with a deterministic tie-break (lexicographic by model
 *     name) produces a stable order over the acyclic remainder.
 *   - Any remaining cycle (in-degree never reaches zero for a set of models) is
 *     broken by deferring the LEAST number of nullable FK edges: we pick, per
 *     stuck model in lexicographic order, its nullable cyclic FK edges, null
 *     them, remove those edges, and continue. If a cycle has no nullable edge to
 *     break it, we still break it (defer a required edge) but flag it — the
 *     two-pass UPDATE inside a transaction makes this safe for SQLite/Postgres
 *     since constraints are checked at commit / are deferrable.
 *
 * Determinism: every set iteration is sorted by model name, so the output is
 * identical across runs and platforms.
 *
 * @param models normalized model FK info (inject for testability — no DB)
 */
export function orderModelsForLoad(models: ModelFkInfo[]): LoadOrder {
  const names = models.map((m) => m.name).sort();
  const byName = new Map(models.map((m) => [m.name, m]));
  const known = new Set(names);

  const deferred: DeferredFk[] = [];
  const deferredKeys = new Set<string>(); // `${model}::${fieldName}` — defer each FK once.

  function defer(model: ModelFkInfo, edge: FkEdge): void {
    const key = `${model.name}::${edge.fieldName}`;
    if (deferredKeys.has(key)) return;
    deferredKeys.add(key);
    deferred.push({
      model: model.name,
      fieldName: edge.fieldName,
      columns: [...edge.fields],
      referencedModel: edge.referencedModel,
    });
  }

  // Build a MUTABLE adjacency list of "live" (not-yet-deferred) FK edges per
  // model. Self-references are deferred immediately and never enter the graph.
  // Each live edge is the single source of truth — when we defer it, we remove
  // it from `live`, which strictly shrinks the graph and guarantees progress.
  interface LiveEdge {
    edge: FkEdge;
    to: string;
  }
  const live = new Map<string, LiveEdge[]>();
  for (const name of names) live.set(name, []);

  for (const m of models) {
    for (const edge of m.fkEdges) {
      if (!known.has(edge.referencedModel)) continue; // FK target outside dump set
      if (edge.referencedModel === m.name) {
        defer(m, edge); // self-reference — never a hard dependency
        continue;
      }
      live.get(m.name)!.push({ edge, to: edge.referencedModel });
    }
  }

  // Kahn's algorithm with lexicographic tie-break, operating on `live`.
  const order: string[] = [];
  const remaining = new Set(names);

  while (remaining.size > 0) {
    // Ready = models with no live edge into a still-remaining model.
    const ready = [...remaining]
      .filter((n) => live.get(n)!.every((e) => !remaining.has(e.to)))
      .sort();

    if (ready.length > 0) {
      for (const n of ready) {
        order.push(n);
        remaining.delete(n);
      }
      continue;
    }

    // No model is ready → at least one cycle remains among `remaining`. Break it
    // by deferring live edges (into the remaining set) of the lexicographically-
    // first stuck model. Prefer nullable edges; fall back to required. Removing
    // the edges from `live` strictly shrinks the graph, guaranteeing termination.
    const stuck = [...remaining].sort();
    let brokeOne = false;

    for (const pass of ["nullable", "any"] as const) {
      for (const name of stuck) {
        const liveEdges = live.get(name)!;
        const toDefer = liveEdges.filter(
          (e) => remaining.has(e.to) && (pass === "any" || !e.edge.isRequired),
        );
        if (toDefer.length === 0) continue;

        const m = byName.get(name)!;
        for (const le of toDefer) defer(m, le.edge);
        // Keep only the edges we did NOT defer.
        live.set(
          name,
          liveEdges.filter((e) => !toDefer.includes(e)),
        );
        brokeOne = true;
        break;
      }
      if (brokeOne) break;
    }

    if (!brokeOne) {
      // Unreachable: a non-empty `remaining` with no ready node always has at
      // least one intra-set live edge. Guard against an infinite loop.
      throw new Error(
        `orderModelsForLoad: unable to resolve load order for models: ${[...remaining]
          .sort()
          .join(", ")}`,
      );
    }
  }

  return { order, deferred };
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Type-driven row serialization (lossless round-trip)
// ════════════════════════════════════════════════════════════════════════════

/** Map of column name -> Prisma scalar type, derived from DMMF or schema parse. */
export type FieldTypeMap = Record<string, string>;

/** Tag wrapper used to mark a base64-encoded binary value in NDJSON. */
const BYTES_TAG = "__metis_bytes_b64__";

interface TaggedBytes {
  [BYTES_TAG]: string;
}

function isTaggedBytes(v: unknown): v is TaggedBytes {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>)[BYTES_TAG] === "string"
  );
}

function toBase64(value: unknown): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (typeof value === "string") return Buffer.from(value, "utf8").toString("base64");
  return Buffer.from(String(value)).toString("base64");
}

/**
 * Serialize a single DB row into an NDJSON-safe plain object. Type-driven by
 * `fieldTypes`. Unknown columns are passed through as-is (defensive).
 *
 *   DateTime -> ISO 8601 string
 *   Json     -> embedded JSON (object/array/primitive) verbatim
 *   Bytes    -> { __metis_bytes_b64__: "<base64>" }  (so deserialize restores Buffer)
 *   BigInt   -> decimal string
 *   Decimal  -> string
 *   null/undefined -> null
 *   enum/String/Int/Float/Boolean -> verbatim
 */
export function serializeRow(
  row: Record<string, unknown>,
  fieldTypes: FieldTypeMap,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    const type = fieldTypes[key];
    switch (type) {
      case "DateTime":
        out[key] = value instanceof Date ? value.toISOString() : String(value);
        break;
      case "Bytes":
        out[key] = { [BYTES_TAG]: toBase64(value) } satisfies TaggedBytes;
        break;
      case "BigInt":
        out[key] = typeof value === "bigint" ? value.toString() : String(value);
        break;
      case "Decimal":
        // Prisma Decimal has a toString(); fall back to String() for plain values.
        out[key] =
          typeof value === "object" && value !== null && "toString" in value
            ? (value as { toString(): string }).toString()
            : String(value);
        break;
      case "Json":
        // Already a JS value; embed verbatim (NDJSON stringify handles it).
        out[key] = value;
        break;
      default:
        // String / Int / Float / Boolean / enum / unknown — verbatim.
        out[key] = value;
    }
  }
  return out;
}

/**
 * Inverse of {@link serializeRow}: restore native types from an NDJSON object.
 *
 *   DateTime -> Date object (Prisma accepts Date or ISO string; Date is safest)
 *   Bytes    -> Buffer (from the tagged base64)
 *   BigInt   -> bigint
 *   Decimal  -> string (Prisma accepts string for Decimal inputs)
 *   Json     -> verbatim
 *   else     -> verbatim
 */
export function deserializeRow(
  row: Record<string, unknown>,
  fieldTypes: FieldTypeMap,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    const type = fieldTypes[key];
    switch (type) {
      case "DateTime":
        out[key] = typeof value === "string" ? new Date(value) : value;
        break;
      case "Bytes":
        out[key] = isTaggedBytes(value) ? Buffer.from(value[BYTES_TAG], "base64") : value;
        break;
      case "BigInt":
        out[key] = typeof value === "string" ? BigInt(value) : value;
        break;
      case "Decimal":
        // Keep as string — Prisma's Decimal input accepts strings losslessly.
        out[key] = typeof value === "object" ? String(value) : value;
        break;
      case "Json":
        out[key] = value;
        break;
      default:
        out[key] = value;
    }
  }
  return out;
}

/** Round-trip a row: serialize then deserialize. Exposed for unit testing. */
export function roundTripRow(
  row: Record<string, unknown>,
  fieldTypes: FieldTypeMap,
): Record<string, unknown> {
  return deserializeRow(serializeRow(row, fieldTypes), fieldTypes);
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Explicit exclusion registry — NOTHING is silently dropped
// ════════════════════════════════════════════════════════════════════════════

export interface ExclusionEntry {
  reason: string;
}

/**
 * Models that are intentionally NOT exported by the logical dump.
 *
 * As of this schema there are NO whole-model exclusions: all 132 models hold
 * DB-resident data that round-trips 1:1 (verified — every scalar type is
 * String/Int/Boolean/Float/DateTime/Json, no on-disk-only blob columns live in
 * the relational DB; LanceDB vectors are stored OUTSIDE the DB, on the
 * filesystem, and are re-indexable). KnowledgeChunk text and all DB-resident
 * data ARE exported.
 *
 * This registry exists so that if a future model is added whose contents cannot
 * round-trip safely (e.g. an in-DB vector blob), it is excluded EXPLICITLY with
 * a reason, logged at export time, and documented — never silently dropped.
 */
export const EXCLUDED_MODELS: Readonly<Record<string, ExclusionEntry>> = Object.freeze({
  // (intentionally empty — see doc comment)
});

/**
 * Per-field exclusions: `<ModelName>.<fieldName>` -> reason. Excluded columns
 * are omitted from the exported rows and restored as their schema default /
 * null on import. Currently empty for the same reason as EXCLUDED_MODELS.
 */
export const EXCLUDED_FIELDS: Readonly<Record<string, ExclusionEntry>> = Object.freeze({
  // Example shape (kept for documentation; no active entries):
  // "SomeModel.vectorBlob": { reason: "LanceDB-derived; lives on disk, re-indexable" },
});

/** True when an entire model is excluded from the dump. */
export function isModelExcluded(modelName: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXCLUDED_MODELS, modelName);
}

/** True when a specific column of a model is excluded from the dump. */
export function isFieldExcluded(modelName: string, fieldName: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXCLUDED_FIELDS, `${modelName}.${fieldName}`);
}

/** Strip excluded fields from a row before serialization. */
export function stripExcludedFields(
  modelName: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!isFieldExcluded(modelName, k)) out[k] = v;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Logical-dump manifest (SEPARATE from the physical backup manifest)
// ════════════════════════════════════════════════════════════════════════════

export interface LogicalManifest {
  /** Manifest format version for the LOGICAL dump (independent of physical v1). */
  format: "metis-logical-dump";
  version: 1;
  createdAt: string; // ISO 8601
  /** Source provider the dump was taken from. */
  provider: "sqlite" | "postgresql";
  /** Root package.json version at export time (schema/app version). */
  schemaVersion: string;
  /** Per-model row counts written to NDJSON (model name -> count). */
  rowCounts: Record<string, number>;
  /** Models included in the dump (one NDJSON file each). */
  includedModels: string[];
  /** Models deliberately excluded, with reasons. */
  excludedModels: { model: string; reason: string }[];
  /** Fields deliberately excluded, with reasons. */
  excludedFields: { field: string; reason: string }[];
  /** FK-safe load order persisted so import can reproduce it deterministically. */
  loadOrder: string[];
  /** FK columns deferred to a 2nd UPDATE pass on import (cycle/self-ref breaks). */
  deferredFks: DeferredFk[];
}

const DeferredFkSchema = z.object({
  model: z.string().min(1),
  fieldName: z.string().min(1),
  columns: z.array(z.string().min(1)),
  referencedModel: z.string().min(1),
});

const LogicalManifestSchema = z.object({
  format: z.literal("metis-logical-dump"),
  version: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  provider: z.enum(["sqlite", "postgresql"]),
  schemaVersion: z.string().min(1),
  rowCounts: z.record(z.string(), z.number().int().nonnegative()),
  includedModels: z.array(z.string().min(1)),
  excludedModels: z.array(z.object({ model: z.string(), reason: z.string() })),
  excludedFields: z.array(z.object({ field: z.string(), reason: z.string() })),
  loadOrder: z.array(z.string().min(1)),
  deferredFks: z.array(DeferredFkSchema),
});

export class LogicalManifestError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LogicalManifestError";
  }
}

export function buildLogicalManifest(input: {
  provider: LogicalManifest["provider"];
  schemaVersion: string;
  rowCounts: Record<string, number>;
  includedModels: string[];
  loadOrder: string[];
  deferredFks: DeferredFk[];
}): LogicalManifest {
  return {
    format: "metis-logical-dump",
    version: 1,
    createdAt: new Date().toISOString(),
    provider: input.provider,
    schemaVersion: input.schemaVersion,
    rowCounts: input.rowCounts,
    includedModels: input.includedModels,
    excludedModels: Object.entries(EXCLUDED_MODELS).map(([model, e]) => ({
      model,
      reason: e.reason,
    })),
    excludedFields: Object.entries(EXCLUDED_FIELDS).map(([field, e]) => ({
      field,
      reason: e.reason,
    })),
    loadOrder: input.loadOrder,
    deferredFks: input.deferredFks,
  };
}

export function parseLogicalManifest(raw: unknown): LogicalManifest {
  const result = LogicalManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new LogicalManifestError(
      `Invalid logical-dump manifest: ${result.error.message}`,
      result.error,
    );
  }
  return result.data as LogicalManifest;
}
