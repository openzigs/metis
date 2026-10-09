"use client";

/**
 * Issue #994 — on the analysis page itself, what a Spec Kit "Start analysis"
 * handoff sent and what it left out. The handoff's toast fired before the
 * redirect and was never seen, so a run that worked from part of the spec
 * looked like one that read all of it.
 *
 * Reads `metadata.specKitHandoff` (persisted when the run started), so it shows
 * while the run is still going and on every later visit. Renders nothing for a
 * run that was not started from a Spec Kit handoff.
 */
import { specKitHandoffSchema, type SpecKitHandoffRecord } from "@metis/shared";

/** The persisted record, or null when absent or malformed. */
export function specKitHandoffOf(
  metadata: Record<string, unknown> | null | undefined,
): SpecKitHandoffRecord | null {
  const parsed = specKitHandoffSchema.safeParse(metadata?.specKitHandoff);
  return parsed.success ? parsed.data : null;
}

export function SpecKitHandoffNotice({
  metadata,
}: {
  metadata: Record<string, unknown> | null | undefined;
}): React.ReactElement | null {
  const handoff = specKitHandoffOf(metadata);
  if (!handoff) return null;
  const { sent, omitted } = handoff;
  return (
    <div data-testid="spec-kit-handoff-notice" className="space-y-1 text-xs">
      <p className="text-muted-foreground">
        Started from a Spec Kit handoff ({handoff.artifacts.join(", ")}).
        {sent.length > 0
          ? ` Sent ${sent.length} requirement${sent.length === 1 ? "" : "s"} from spec.md: ${sent.join(", ")}.`
          : null}
      </p>
      {omitted.length > 0 ? (
        <p className="text-warning" role="status" data-testid="spec-kit-handoff-omitted">
          Not sent — {omitted.length === 1 ? "it" : "they"} did not fit the analysis input limit:{" "}
          {omitted.join(", ")}. This run did not evaluate {omitted.length === 1 ? "it" : "them"}.
        </p>
      ) : null}
    </div>
  );
}
