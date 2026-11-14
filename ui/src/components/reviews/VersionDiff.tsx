/**
 * Epic #609 / Issue #618 — field-level requirement version diff.
 *
 * Renders the compact `{ field: { from, to } }` diff shape produced by the
 * requirement-history substrate (epic #770) — no client-side recomputation.
 *
 * #1581 — a requirement's `body` is Markdown carrying METIS block markers
 * (`<!-- metis:clarifications:start -->` …). Printed as text, the review card
 * and the baseline compare showed raw `##`, `**Q:**` and the markers, although
 * the pinned body beside them renders. Both sides of a body change now render
 * through the same `RequirementBody` (#998), and no string value shows a marker.
 *
 * #2220 — a field is shown by its name ("Acceptance criteria", not
 * `acceptanceCriteria`), and a list field (criteria, labels) as the items it
 * removed and added, one per line, instead of both whole JSON arrays. A change
 * only to hidden `finding:` labels is no change a reader can see, so it is not
 * listed. A list compared item by item, not as a set: a duplicated item is
 * an addition, and a reorder alone shows the order before and after.
 */
import type { ChangedFields } from "@/lib/history-api";
import { RequirementBody } from "@/components/analysis/RequirementBody";
import {
  listChange,
  requirementFieldLabel,
  requirementListItems,
  requirementValueText,
} from "@/lib/requirement-fields";

/** The diff fields whose values are Markdown requirement bodies. */
const MARKDOWN_FIELDS: ReadonlySet<string> = new Set(["body"]);

/** Human-readable rendering of a diff value. Exported for unit testing. */
export const formatDiffValue = requirementValueText;

const SIDE_CLASS = {
  from: "bg-destructive/10 text-destructive",
  to: "bg-success-muted text-success",
} as const;

/** One side of a change: `<del>` for the old value, `<ins>` for the new one. */
function DiffSide({ side, field, value }: { side: "from" | "to"; field: string; value: unknown }) {
  const Tag = side === "from" ? "del" : "ins";
  const text = formatDiffValue(value);
  const markdown = MARKDOWN_FIELDS.has(field) && typeof value === "string" && text !== "—";
  // Rendered Markdown lays out its own blocks; `pre-wrap` would add the
  // newlines between them as blank lines.
  const layout = markdown ? "" : "whitespace-pre-wrap";
  return (
    <Tag
      className={`block break-words rounded px-2 py-1 no-underline ${layout} ${SIDE_CLASS[side]}`}
      data-testid={`diff-${side}`}
    >
      {/* Headings stay below the card's own `h4` section heading. */}
      {markdown ? <RequirementBody body={value} minHeadingLevel={5} /> : text}
    </Tag>
  );
}

/** #2220 — a reorder only: the whole list before and after, numbered. */
function OrderChange({ from, to }: { from: string[]; to: string[] }) {
  const numbered = (items: string[]) => items.map((x, i) => `${i + 1}. ${x}`).join("\n");
  const block = "block whitespace-pre-wrap break-words rounded px-2 py-1 no-underline";
  return (
    <>
      <p className="text-muted-foreground">Order changed</p>
      <del className={`${block} ${SIDE_CLASS.from}`} data-testid="diff-from">
        {numbered(from)}
      </del>
      <ins className={`${block} ${SIDE_CLASS.to}`} data-testid="diff-to">
        {numbered(to)}
      </ins>
    </>
  );
}

/** #2220 — a list field's change: each removed item struck, each added item inserted. */
function ListChange({ removed, added }: { removed: string[]; added: string[] }) {
  const item = "block whitespace-pre-wrap break-words rounded px-2 py-1 no-underline";
  return (
    <>
      {removed.map((text, i) => (
        <del key={`from-${i}`} className={`${item} ${SIDE_CLASS.from}`} data-testid="diff-from">
          {text}
        </del>
      ))}
      {added.map((text, i) => (
        <ins key={`to-${i}`} className={`${item} ${SIDE_CLASS.to}`} data-testid="diff-to">
          {text}
        </ins>
      ))}
    </>
  );
}

type FieldRow =
  | { field: string; kind: "list"; removed: string[]; added: string[] }
  | { field: string; kind: "order"; from: string[]; to: string[] }
  | { field: string; kind: "value"; from: unknown; to: unknown };

/** The rows to show: a list field that changed nothing visible is left out. */
function fieldRows(changedFields: ChangedFields): FieldRow[] {
  return Object.entries(changedFields).flatMap(([field, change]): FieldRow[] => {
    const from = requirementListItems(field, change.from);
    const to = requirementListItems(field, change.to);
    if (from === null || to === null) {
      return [{ field, kind: "value", from: change.from, to: change.to }];
    }
    const { removed, added, reordered } = listChange(from, to);
    if (reordered) return [{ field, kind: "order", from, to }];
    return removed.length + added.length === 0 ? [] : [{ field, kind: "list", removed, added }];
  });
}

export function VersionDiff({ changedFields }: { changedFields: ChangedFields }) {
  const rows = fieldRows(changedFields);
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No field changes recorded for this version.</p>
    );
  }
  return (
    <dl className="space-y-2" data-testid="version-diff">
      {rows.map((row) => (
        <div key={row.field} data-testid={`diff-field-${row.field}`} className="text-xs">
          <dt className="font-semibold text-muted-foreground">
            {requirementFieldLabel(row.field)}
          </dt>
          <dd className="mt-0.5 space-y-0.5">
            {row.kind === "list" ? (
              <ListChange removed={row.removed} added={row.added} />
            ) : row.kind === "order" ? (
              <OrderChange from={row.from} to={row.to} />
            ) : (
              <>
                <DiffSide side="from" field={row.field} value={row.from} />
                <DiffSide side="to" field={row.field} value={row.to} />
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
