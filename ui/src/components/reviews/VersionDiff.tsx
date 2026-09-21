/**
 * Epic #609 / Issue #618 — field-level requirement version diff.
 *
 * Renders the compact `{ field: { from, to } }` diff shape produced by the
 * requirement-history substrate (epic #770) — no client-side recomputation.
 */
import type { ChangedFields } from "@/lib/history-api";

/** Human-readable rendering of a diff value. Exported for unit testing. */
export function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
            <del className="block whitespace-pre-wrap break-words rounded bg-red-500/10 px-2 py-1 text-red-700 no-underline dark:text-red-400">
              {formatDiffValue(change.from)}
            </del>
            <ins className="block whitespace-pre-wrap break-words rounded bg-emerald-500/10 px-2 py-1 text-emerald-700 no-underline dark:text-emerald-400">
              {formatDiffValue(change.to)}
            </ins>
          </dd>
        </div>
      ))}
    </dl>
  );
}
