"use client";

/**
 * Issue #769 — say when a re-synthesis was NOT allowed to replace the
 * requirement set.
 *
 * Regenerate on one agent re-runs synthesis in the background. Before #769 that
 * re-synthesis hard-deleted the reviewed set (approvals, edits, links, data
 * mappings, baseline pins) minutes later, with nothing on screen. The server now
 * refuses that replacement and records why; this notice is where the user reads
 * it, so a Regenerate that changed no requirements is explained.
 */
import {
  describeRequirementReplacementWithheld,
  type RequirementReplacementWithheld,
} from "@metis/shared";

/**
 * Read the key directly (not through `readEnhancementMetadata`): like
 * `SynthesisDegradedNotice`, this renders on every analysis view, and the
 * page-level suites replace `@/lib/analysis-api` wholesale.
 */
function readWithheld(
  metadata: Record<string, unknown> | null | undefined,
): RequirementReplacementWithheld | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as { requirementReplacementWithheld?: unknown })
    .requirementReplacementWithheld;
  return value && typeof value === "object" ? (value as RequirementReplacementWithheld) : undefined;
}

export function RequirementReplacementWithheldNotice({
  metadata,
}: {
  metadata: Record<string, unknown> | null | undefined;
}): React.ReactElement | null {
  const withheld = readWithheld(metadata);
  if (!withheld) return null;

  return (
    <div
      role="status"
      data-testid="requirement-replacement-withheld"
      className="rounded border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning"
    >
      <p>
        <span aria-hidden>⚠</span> {describeRequirementReplacementWithheld(withheld)}
      </p>
    </div>
  );
}
