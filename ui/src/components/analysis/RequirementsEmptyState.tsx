"use client";

/**
 * Issue #1104 (finding B) — the empty REQUIREMENTS list, told honestly.
 *
 * A run that synthesized 14 requirements and had every one of them withheld by
 * the approval gate used to render the same "No requirements yet." as a run
 * that genuinely produced nothing. That single line is what made a gated run
 * indistinguishable from a lost one. When the analysis metadata records a
 * blocked promotion, say what exists, what is blocking it, and where to go.
 */
import { readEnhancementMetadata } from "@/lib/analysis-api";

export function RequirementsEmptyState({
  metadata,
}: {
  metadata: Record<string, unknown> | null | undefined;
}): React.ReactElement {
  const blocked = readEnhancementMetadata(metadata).promotionBlocked;

  if (!blocked?.blocked) {
    return <p className="text-sm text-zinc-500">No requirements yet.</p>;
  }

  const awaiting = blocked.awaitingRequirementCount ?? 0;
  const outstanding: string[] = [];
  if (blocked.pendingCount > 0) outstanding.push(`${blocked.pendingCount} pending`);
  if (blocked.rejectedCount > 0) outstanding.push(`${blocked.rejectedCount} rejected`);

  return (
    <div
      role="alert"
      data-testid="requirements-gated"
      className="space-y-1 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300"
    >
      <p>
        <span aria-hidden>⚠</span>{" "}
        {awaiting > 0
          ? `${awaiting} requirement(s) awaiting approval — they were generated but are not saved yet.`
          : "Requirements are awaiting approval before they are saved."}
      </p>
      <p className="text-xs text-amber-200/80">
        {outstanding.length > 0
          ? `${outstanding.join(", ")} approval(s) must be resolved.`
          : "Resolve the outstanding approvals to release them."}{" "}
        <a href="#approvals" className="font-medium underline">
          Go to approvals
        </a>
      </p>
    </div>
  );
}
