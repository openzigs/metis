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
 */
import { stripMetisMarkers } from "@metis/shared";
import type { ChangedFields } from "@/lib/history-api";
import { RequirementBody } from "@/components/analysis/RequirementBody";

/** The diff fields whose values are Markdown requirement bodies. */
const MARKDOWN_FIELDS: ReadonlySet<string> = new Set(["body"]);

/** Human-readable rendering of a diff value. Exported for unit testing. */
export function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return stripMetisMarkers(value).trim() || "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

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

export function VersionDiff({ changedFields }: { changedFields: ChangedFields }) {
  const fields = Object.entries(changedFields);
  if (fields.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No field changes recorded for this version.</p>
    );
  }
  return (
    <dl className="space-y-2" data-testid="version-diff">
      {fields.map(([field, change]) => (
        <div key={field} data-testid={`diff-field-${field}`} className="text-xs">
          <dt className="font-semibold text-muted-foreground">{field}</dt>
          <dd className="mt-0.5 space-y-0.5">
            <DiffSide side="from" field={field} value={change.from} />
            <DiffSide side="to" field={field} value={change.to} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
