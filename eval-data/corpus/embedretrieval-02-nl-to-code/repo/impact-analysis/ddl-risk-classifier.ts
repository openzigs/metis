/**
 * Deterministic DDL risk classifier — expand/contract discipline (Epic #820
 * Phase 3, #830).
 *
 * Given one suggested DDL change (a {@link DdlChangeKind} plus, when known, the
 * before/after column type and the TEXT-ONLY suggested DDL), decide whether the
 * change is `breaking`, `expanding`, or `neutral` so gap reports and verdicts can
 * triage risk. This mirrors the standard safe-migration discipline used by
 * Liquibase / Atlas / pgroll: *contract* operations (drops, narrowings) are
 * flagged loudly; *expand* operations (additive/widening) are safe.
 *
 * ## Mapping (documented, exhaustive over {@link DDL_CHANGE_KINDS})
 *
 * | changeKind      | result     | rationale                                            |
 * | --------------- | ---------- | ---------------------------------------------------- |
 * | `drop-column`   | breaking   | drops an object existing consumers may read/write    |
 * | `add-table`     | expanding  | a brand-new table has no existing consumer to break  |
 * | `add-column`    | expanding  | additive — UNLESS `NOT NULL` without a default        |
 * | `add-column`    | breaking   | `NOT NULL` and no `DEFAULT` breaks existing inserts   |
 * | `alter-column`  | expanding  | type widens / stays the same and nullability relaxes  |
 * | `alter-column`  | breaking   | type narrows, nullability tightens, or types unknown  |
 * | `reference`     | neutral    | verify-only; no structural change                     |
 * | (unknown kind)  | breaking   | conservative default — NEVER silently `neutral`       |
 *
 * Plus one cross-cutting safety net: any suggestion whose DDL text contains an
 * explicit destructive `DROP TABLE` / `DROP COLUMN` is `breaking` regardless of
 * its declared `changeKind` (covers a drop-table that only surfaces in text).
 *
 * ## Guarantees
 *
 * - **Pure & deterministic** — no I/O, no LLM, no clock/random; same input ⇒
 *   same output. Fully unit-testable across the kind × type matrix.
 * - **Conservative** — when the before/after shape is unknown or ambiguous, the
 *   result is `breaking`, never `neutral` (the only `neutral` is `reference`).
 * - **Advisory only** — the output is triage over TEXT-ONLY suggestions; it
 *   NEVER gates or triggers any execution path (none exists).
 */
import type { DdlChangeKind, DdlRiskClass, SchemaReconciliation } from "@metis/shared";

/**
 * Input for {@link classifyDdlRisk}. `changeKind` is the only required signal;
 * everything else refines the `add-column` / `alter-column` branches.
 */
export interface ClassifyDdlRiskInput {
  /** The suggested change kind (from the impact engine's `suggestDdl`). */
  changeKind: DdlChangeKind;
  /**
   * Reconciliation status against the live schema. Accepted for API symmetry
   * with the issue spec (and future refinement): the impact engine already
   * ENCODES reconciliation into `changeKind` (`table-not-found` ⇒ `add-table`,
   * `column-not-found` ⇒ `add-column`, matched/null ⇒ `reference`), so the
   * classification is driven by `changeKind` and does not re-read this field.
   */
  reconciliation?: SchemaReconciliation | null;
  /** The TEXT-ONLY suggested DDL, scanned for `NOT NULL`/`DEFAULT`/`DROP`. */
  suggestedDdl?: string | null;
  /** The column's type before the change (`alter-column`), when known. */
  columnTypeBefore?: string | null;
  /** The column's type after the change (`add-column`/`alter-column`), when known. */
  columnTypeAfter?: string | null;
}

/** Direction of a same-family column type change, for {@link columnWidthDirection}. */
type WidthDirection = "widen" | "narrow" | "same" | "unknown";

/** Collapse internal whitespace and l-trim/lower for tolerant token scans. */
function normalize(text: string | null | undefined): string {
  if (text == null) return "";
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Does the DDL/type text declare `NOT NULL`? */
function hasNotNull(text: string | null | undefined): boolean {
  return normalize(text).includes("not null");
}

/** Does the DDL/type text supply a `DEFAULT`? */
function hasDefault(text: string | null | undefined): boolean {
  return normalize(text).includes("default");
}

/**
 * Does the suggested DDL contain an explicit destructive DROP? A `DROP TABLE` or
 * `DROP COLUMN` is always breaking, whatever the declared `changeKind` — this is
 * the safety net for a drop-table suggestion that carries no dedicated kind.
 */
function mentionsDestructiveDrop(suggestedDdl: string | null | undefined): boolean {
  const ddl = normalize(suggestedDdl);
  return ddl.includes("drop table") || ddl.includes("drop column");
}

/**
 * Nullability tightening: the column becomes `NOT NULL` where it was previously
 * nullable. Only asserted when we KNOW the before state (a nullable/absent
 * `NOT NULL`) and the after state is `NOT NULL`; an unknown `before` is left to
 * the width comparison (which conservatively yields `breaking`).
 */
function tightensNullability(
  before: string | null | undefined,
  after: string | null | undefined,
): boolean {
  return hasNotNull(after) && before != null && before !== "" && !hasNotNull(before);
}

/** A parsed SQL column type reduced to a comparable family + magnitude. */
interface ParsedType {
  family: "integer" | "float" | "string" | "binary" | "decimal";
  /** Comparable magnitude within a family (bit-width, length, or precision). */
  magnitude: number;
  /** Fractional scale, for the `decimal` family only. */
  scale: number;
}

/** Bit-widths for integer / serial types (drives narrow-vs-widen ranking). */
const INTEGER_BITS: Readonly<Record<string, number>> = {
  tinyint: 8,
  smallserial: 16,
  smallint: 16,
  mediumint: 24,
  int: 32,
  integer: 32,
  serial: 32,
  bigint: 64,
  bigserial: 64,
};

/** Approximate bit-widths for floating-point types. */
const FLOAT_BITS: Readonly<Record<string, number>> = {
  real: 24,
  float: 53,
  double: 53,
};

/** Bounded string types carry a length; unbounded ones are treated as ∞. */
const STRING_BASES = new Set(["char", "character", "varchar", "varchar2", "nchar", "nvarchar"]);
const UNBOUNDED_STRING_BASES = new Set(["text", "clob", "ntext", "string", "longtext"]);
const BINARY_BASES = new Set(["binary", "varbinary"]);
const UNBOUNDED_BINARY_BASES = new Set(["bytea", "blob", "longblob"]);
const DECIMAL_BASES = new Set(["decimal", "numeric", "number", "dec"]);

/** Rewrite multiword type spellings to a single canonical base token. */
function canonicalizeSpelling(text: string): string {
  return text
    .replaceAll("character varying", "varchar")
    .replaceAll("double precision", "double")
    .replaceAll("int4", "int")
    .replaceAll("int2", "smallint")
    .replaceAll("int8", "bigint")
    .replaceAll("float4", "real")
    .replaceAll("float8", "double");
}

/** Strip trailing column constraints so only the type shape is compared. */
function stripConstraints(text: string): string {
  for (const marker of [" not null", " null", " default", " generated", " primary key"]) {
    const at = text.indexOf(marker);
    if (at !== -1) text = text.slice(0, at);
  }
  return text.trim();
}

/** Parse the numeric arguments inside a type's parentheses, e.g. `(10, 2)`. */
function parseArgs(typeText: string): number[] {
  const open = typeText.indexOf("(");
  if (open === -1) return [];
  const close = typeText.indexOf(")", open);
  const inner = typeText.slice(open + 1, close === -1 ? typeText.length : close);
  return inner
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * Reduce a raw SQL type string to a comparable {@link ParsedType}, or `null` when
 * it is empty or of an unrecognized family (⇒ the caller treats it as unknown).
 */
function parseColumnType(raw: string | null | undefined): ParsedType | null {
  if (raw == null) return null;
  const cleaned = stripConstraints(canonicalizeSpelling(normalize(raw)));
  if (cleaned === "") return null;

  const open = cleaned.indexOf("(");
  const base = (open === -1 ? cleaned : cleaned.slice(0, open)).trim();
  const args = parseArgs(cleaned);

  if (base in INTEGER_BITS) {
    return { family: "integer", magnitude: INTEGER_BITS[base]!, scale: 0 };
  }
  if (base in FLOAT_BITS) {
    return { family: "float", magnitude: FLOAT_BITS[base]!, scale: 0 };
  }
  if (DECIMAL_BASES.has(base)) {
    return {
      family: "decimal",
      magnitude: args[0] ?? Number.POSITIVE_INFINITY,
      scale: args[1] ?? 0,
    };
  }
  if (UNBOUNDED_STRING_BASES.has(base)) {
    return { family: "string", magnitude: Number.POSITIVE_INFINITY, scale: 0 };
  }
  if (STRING_BASES.has(base)) {
    return { family: "string", magnitude: args[0] ?? Number.POSITIVE_INFINITY, scale: 0 };
  }
  if (UNBOUNDED_BINARY_BASES.has(base)) {
    return { family: "binary", magnitude: Number.POSITIVE_INFINITY, scale: 0 };
  }
  if (BINARY_BASES.has(base)) {
    return { family: "binary", magnitude: args[0] ?? Number.POSITIVE_INFINITY, scale: 0 };
  }
  return null;
}

/**
 * Classify a `before → after` column type change as widening, narrowing, the
 * same, or unknown. Cross-family changes and unrecognized types are `unknown`
 * (the caller conservatively treats that as `breaking`). For `decimal`, both the
 * integer part (`precision − scale`) and the scale must not shrink for a widen.
 */
export function columnWidthDirection(
  before: string | null | undefined,
  after: string | null | undefined,
): WidthDirection {
  const a = parseColumnType(before);
  const b = parseColumnType(after);
  if (!a || !b || a.family !== b.family) return "unknown";

  if (a.family === "decimal") {
    const aInt = a.magnitude - a.scale;
    const bInt = b.magnitude - b.scale;
    if (a.magnitude === b.magnitude && a.scale === b.scale) return "same";
    if (b.scale >= a.scale && bInt >= aInt) return "widen";
    if (b.scale <= a.scale && bInt <= aInt) return "narrow";
    return "unknown";
  }

  if (a.magnitude === b.magnitude) return "same";
  return b.magnitude > a.magnitude ? "widen" : "narrow";
}

/** `add-column`: additive unless it is `NOT NULL` without a `DEFAULT`. */
function classifyAddColumn(input: ClassifyDdlRiskInput): DdlRiskClass {
  const declaresNotNull = hasNotNull(input.suggestedDdl) || hasNotNull(input.columnTypeAfter);
  const suppliesDefault = hasDefault(input.suggestedDdl) || hasDefault(input.columnTypeAfter);
  return declaresNotNull && !suppliesDefault ? "breaking" : "expanding";
}

/**
 * `alter-column`: `expanding` ONLY when the change is provably safe for existing
 * consumers — the type widens (or is unchanged) AND nullability does not tighten.
 * Narrowing, nullability tightening, cross-family, and unknown types are all
 * conservatively `breaking`.
 */
function classifyAlterColumn(input: ClassifyDdlRiskInput): DdlRiskClass {
  if (tightensNullability(input.columnTypeBefore, input.columnTypeAfter)) return "breaking";
  const direction = columnWidthDirection(input.columnTypeBefore, input.columnTypeAfter);
  return direction === "widen" || direction === "same" ? "expanding" : "breaking";
}

/**
 * Classify one suggested DDL change as `breaking` | `expanding` | `neutral`.
 * Pure, deterministic, LLM-free — see the module header for the full mapping.
 */
export function classifyDdlRisk(input: ClassifyDdlRiskInput): DdlRiskClass {
  // Safety net: an explicit destructive DROP in the text is ALWAYS breaking,
  // regardless of the declared changeKind (covers a drop-table suggestion).
  if (mentionsDestructiveDrop(input.suggestedDdl)) return "breaking";

  switch (input.changeKind) {
    case "drop-column":
      return "breaking";
    case "add-table":
      return "expanding";
    case "add-column":
      return classifyAddColumn(input);
    case "alter-column":
      return classifyAlterColumn(input);
    case "reference":
      return "neutral";
    default:
      // Unknown/ambiguous change kind ⇒ conservative breaking, never silent
      // neutral (guards against a future DdlChangeKind slipping through).
      return "breaking";
  }
}
