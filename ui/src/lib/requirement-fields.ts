/**
 * Issue #2220 — a requirement's versioned fields as a reader sees them.
 *
 * The review diff, the baseline compare and the History tab showed each field
 * by its column name (`acceptanceCriteria`, `storyPoints`) and the list fields
 * as their stored JSON: escaped quotes, the whole array as one block, and the
 * hidden `finding:<id>` traceability labels that no other surface shows. Here a
 * field has a name, a list field is its items, and a hidden label is left out.
 */
import { stripMetisMarkers } from "@metis/shared";

const FIELD_LABELS: Readonly<Record<string, string>> = {
  title: "Title",
  body: "Description",
  priority: "Priority",
  type: "Type",
  labels: "Labels",
  storyPoints: "Story points",
  acceptanceCriteria: "Acceptance criteria",
  kind: "Kind",
  nfrCategory: "Non-functional category",
  reviewStatus: "Review status",
};

/** A field's name for a reader: a known label, else the words of its key. */
export function requirementFieldLabel(field: string): string {
  const known = FIELD_LABELS[field];
  if (known) return known;
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The fields whose value is a list, stored as a JSON array string. */
const LIST_FIELDS: ReadonlySet<string> = new Set(["acceptanceCriteria", "labels"]);

/**
 * A label the server keeps from every reader (`isHiddenRequirementLabel` in
 * `server/src/lib/analysis/requirement-labels.ts`): `finding:*` traceability
 * and legacy `review:*`.
 */
export function isHiddenRequirementLabel(label: string): boolean {
  return label.startsWith("finding:") || label.startsWith("review:");
}

/**
 * The items of a list field's value — a JSON array string, an array, or plain
 * text (one item) — trimmed, blanks dropped and, for labels, hidden ones left
 * out. `null` when `field` is not a list field.
 */
export function requirementListItems(field: string, value: unknown): string[] | null {
  if (!LIST_FIELDS.has(field)) return null;
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      raw = [value];
    }
  }
  if (raw === null || raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const items = list
    .filter((x) => typeof x === "string" || typeof x === "number")
    .map((x) => String(x).trim())
    .filter((x) => x.length > 0);
  return field === "labels" ? items.filter((l) => !isHiddenRequirementLabel(l)) : items;
}

/** The items only one side holds: what a list change removed and what it added. */
export function listChange(
  from: readonly string[],
  to: readonly string[],
): { removed: string[]; added: string[] } {
  const before = new Set(from);
  const after = new Set(to);
  return {
    removed: from.filter((x) => !after.has(x)),
    added: to.filter((x) => !before.has(x)),
  };
}

/** A scalar value as text; `—` for none. Markers never show (#1581). */
export function requirementValueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return stripMetisMarkers(value).trim() || "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * A snapshot as the lines a text diff compares: one `Name: value` line per
 * field, and a list field as its name with one `• item` line per item, so a
 * changed criterion is one changed line rather than a changed JSON block.
 */
export function snapshotDiffText(
  snapshot: Record<string, unknown>,
  fields: readonly string[],
): string {
  return fields
    .flatMap((field) => {
      const label = requirementFieldLabel(field);
      const items = requirementListItems(field, snapshot[field]);
      if (items === null) return [`${label}: ${requirementValueText(snapshot[field])}`];
      return items.length === 0 ? [`${label}: —`] : [`${label}:`, ...items.map((i) => `  • ${i}`)];
    })
    .join("\n");
}
