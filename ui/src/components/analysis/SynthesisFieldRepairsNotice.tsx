"use client";

/**
 * Issue #1099 — say which values synthesis could not use.
 *
 * One malformed optional field (`storyPoints: null`, an over-long label) used to
 * discard the model's whole reply. Synthesis now keeps the reply and leaves out
 * only the bad value — and since these fields are published to trackers and
 * Spec Kit, the analyst is told exactly what was left out, per requirement.
 *
 * Reads the key directly (not through `@/lib/analysis-api`) for the reason
 * `SynthesisDegradedNotice` gives: page suites replace that module wholesale.
 */
import {
  describeSynthesisFieldRepair,
  describeSynthesisFieldRepairs,
  readSynthesisFieldRepairs,
} from "@metis/shared";

export function SynthesisFieldRepairsNotice({
  metadata,
}: {
  metadata: Record<string, unknown> | null | undefined;
}): React.ReactElement | null {
  const record = readSynthesisFieldRepairs(
    metadata && typeof metadata === "object"
      ? (metadata as { synthesisFieldRepairs?: unknown }).synthesisFieldRepairs
      : undefined,
  );
  if (!record) return null;
  const more = record.total - record.repairs.length;

  return (
    <div
      role="status"
      data-testid="synthesis-field-repairs"
      className="space-y-1 rounded border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning"
    >
      <p>
        <span aria-hidden>⚠</span> {describeSynthesisFieldRepairs(record)}
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-xs">
        {record.repairs.map((r, i) => (
          <li key={`${r.requirementNumber ?? "reply"}-${r.field}-${r.action}-${i}`}>
            {describeSynthesisFieldRepair(r)}
          </li>
        ))}
      </ul>
      {more > 0 && (
        <p className="text-xs" data-testid="synthesis-field-repairs-more">
          …and {more} more.
        </p>
      )}
    </div>
  );
}
