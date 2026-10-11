/**
 * #1036 — decide which affected symbols are EDIT CANDIDATES and which are BLAST
 * RADIUS, once every stage has run.
 *
 * The role is carried by `depth` (0 = edit candidate; see `impactSymbolRole` in
 * `@metis/shared`), so this is where depths are settled:
 *
 *   - a retrieval seed (`direct`) is an edit candidate already;
 *   - a lineage writer (`data-writer`) is PROMOTED to an edit candidate only when
 *     something besides the lineage says the request is about its data: it sits
 *     in a file the seeding selected, it writes a column the request names, or
 *     its table gains a column. Otherwise it stays in the blast radius — run 7
 *     listed the `entries` status writers as "directly affected" for a UI
 *     pagination bug (#4386) whose fix touches no storage code;
 *   - a table that gains a column brings its definition and the types named for
 *     it (`data-model`) in as edit candidates;
 *   - what the seeding retrieved but did not select (`related`) is appended as
 *     blast radius.
 *
 * Pure — no I/O.
 */
import type { ImpactAffectedRelation } from "@metis/shared";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";
import type { DataPathWriter } from "./data-path-writers.js";
import type { AffectedTableInput, CodeSymbolDetail } from "./schema-impact.js";

/** An affected-symbol row, as the engine builds it. */
export interface RoleSymbol {
  codeSymbolId: string | null;
  filePath: string;
  qualifiedName: string;
  startLine: number | null;
  endLine: number | null;
  relation: ImpactAffectedRelation;
  depth: number;
  confidence: number;
}

export interface AssignImpactRolesInput {
  /** Every writer the lineage named, including ones the seeding found first. */
  writers: readonly DataPathWriter[];
  /** Tables with an `add-column` row in the final primary set. */
  growingTables: readonly string[];
  /** Definition sites and types of {@link growingTables}. */
  dataModel: readonly CodeSymbolDetail[];
  /** Retrieved for the request, below the edit-candidate cut. */
  related: readonly RequirementCodeMatch[];
}

/** Confidence of a `data-model` row: structural, below a retrieval seed. */
export const DATA_MODEL_CONFIDENCE = 0.6;

/** The tables with an `add-column` row, in first-seen order. */
export function tablesGainingColumns(tables: readonly AffectedTableInput[]): string[] {
  return [...new Set(tables.filter((t) => t.changeKind === "add-column").map((t) => t.tableName))];
}

/** `entries.status` → `entries`; `public.entries.status` → `public.entries`. */
function tableOfColumn(qualifiedColumn: string): string {
  const dot = qualifiedColumn.lastIndexOf(".");
  return dot === -1 ? qualifiedColumn : qualifiedColumn.slice(0, dot);
}

/** `public.entries` and `entries` name the same table for this purpose. */
function bareTable(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

export function assignImpactRoles<T extends RoleSymbol>(
  symbols: T[],
  input: AssignImpactRolesInput,
): Array<T | RoleSymbol> {
  const editFiles = new Set(
    symbols.filter((s) => s.relation === "direct" && s.depth === 0).map((s) => s.filePath),
  );
  const growing = new Set(input.growingTables.map(bareTable));
  const writerById = new Map(input.writers.map((w) => [w.id, w]));
  const isEditWriter = (id: string | null, filePath: string): boolean => {
    const writer = id ? writerById.get(id) : undefined;
    if (!writer) return false;
    return (
      editFiles.has(filePath) ||
      writer.namesRequirementColumn ||
      writer.columns.some((c) => growing.has(bareTable(tableOfColumn(c))))
    );
  };

  const out: Array<T | RoleSymbol> = symbols.map((s) =>
    s.relation === "data-writer" && s.depth !== 0 && isEditWriter(s.codeSymbolId, s.filePath)
      ? { ...s, depth: 0 }
      : s,
  );
  const indexById = new Map<string, number>();
  out.forEach((s, i) => {
    if (s.codeSymbolId) indexById.set(s.codeSymbolId, i);
  });

  for (const d of input.dataModel) {
    const row: RoleSymbol = {
      codeSymbolId: d.id,
      filePath: d.filePath,
      qualifiedName: d.qualifiedName,
      startLine: d.startLine,
      endLine: d.endLine,
      relation: "data-model",
      depth: 0,
      confidence: DATA_MODEL_CONFIDENCE,
    };
    const at = indexById.get(d.id);
    if (at === undefined) {
      indexById.set(d.id, out.length);
      out.push(row);
    } else if (out[at]!.depth !== 0) {
      // Already listed as a caller: the stronger claim replaces it.
      out[at] = row;
    }
  }

  for (const r of input.related) {
    if (r.codeSymbolId && indexById.has(r.codeSymbolId)) continue;
    if (r.codeSymbolId) indexById.set(r.codeSymbolId, out.length);
    out.push({
      codeSymbolId: r.codeSymbolId,
      filePath: r.filePath,
      qualifiedName: r.qualifiedName,
      startLine: r.startLine,
      endLine: r.endLine,
      relation: "related",
      depth: 1,
      confidence: r.confidence,
    });
  }

  return out.sort((a, b) => a.depth - b.depth || b.confidence - a.confidence);
}
