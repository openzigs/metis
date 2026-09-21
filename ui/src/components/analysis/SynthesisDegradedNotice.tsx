"use client";

/**
 * Issue #1117 (findings B + C) — say when the requirements below were not
 * classified.
 *
 * The verification walkthrough that filed #1117 found 16 of 16 requirements
 * typed `[Feature]` — including "Plaintext passwords stored in SIGNON table" —
 * and 0 of 16 carrying acceptance criteria, and reported them as two separate
 * defects with two separate wrong theories ("the classifier regressed", "the
 * deriver never fired"). They were one cause: synthesis fell back to a keyword
 * clusterer that hardcodes both fields.
 *
 * Nothing on screen said so. This notice is the difference between a
 * multi-hour forensic dig through persisted JSON and a sentence.
 */
import { describeSynthesisDegradation, type SynthesisDegradation } from "@metis/shared";

/**
 * Read the key directly rather than through `readEnhancementMetadata`. This
 * notice renders on EVERY analysis view (it self-hides), and the page-level
 * suites replace `@/lib/analysis-api` wholesale — depending on a helper from
 * that module for what is only a cast would blank the whole page under those
 * mocks. The narrowing below is the same one the helper performs.
 */
function readDegradation(
  metadata: Record<string, unknown> | null | undefined,
): SynthesisDegradation | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as { synthesisDegraded?: unknown }).synthesisDegraded;
  return value && typeof value === "object" ? (value as SynthesisDegradation) : undefined;
}

export function SynthesisDegradedNotice({
  metadata,
}: {
  metadata: Record<string, unknown> | null | undefined;
}): React.ReactElement | null {
  const degraded = readDegradation(metadata);
  if (!degraded) return null;

  return (
    <div
      role="alert"
      data-testid="synthesis-degraded"
      className="space-y-1 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300"
    >
      <p>
        <span aria-hidden>⚠</span> {describeSynthesisDegradation(degraded)}
      </p>
      {degraded.detail && (
        <p className="font-mono text-xs text-amber-200/70" data-testid="synthesis-degraded-detail">
          {degraded.detail}
        </p>
      )}
    </div>
  );
}
