"use client";

import type { DeepIngestOutcome } from "@/hooks/use-deep-ingest";

export type DeepIngestBannerTone = "success" | "warning" | "error";

/**
 * #432 — how a finished Deep Ingest should look. A run that completed with
 * failures skipped document regeneration and needs re-running, so it is a
 * warning, never success-green.
 */
export function deepIngestBannerTone(outcome: DeepIngestOutcome): DeepIngestBannerTone {
  if (outcome.status === "failed") return "error";
  return outcome.failureCount > 0 ? "warning" : "success";
}

const COMPLETED_STYLES = {
  success: { box: "border-success/40 bg-success-muted", text: "text-success" },
  warning: { box: "border-warning/40 bg-warning-muted", text: "text-warning" },
} as const;

/** The banner under the repository list reporting how the last Deep Ingest ended. */
export function DeepIngestOutcomeBanner({ outcome }: { outcome: DeepIngestOutcome | null }) {
  if (!outcome) return null;
  const tone = deepIngestBannerTone(outcome);
  if (tone === "error") {
    return (
      <div
        className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm"
        role="alert"
      >
        <div className="mb-1 font-medium text-destructive">Deep ingest failed</div>
        <div className="text-xs text-foreground">{outcome.message}</div>
      </div>
    );
  }
  const styles = COMPLETED_STYLES[tone];
  return (
    <div className={`rounded border ${styles.box} p-3 text-sm`} role="status">
      {/* The server's line already reads "Deep ingest complete: …" or
          "Deep ingest completed with N failures: …". */}
      <div className={`font-medium ${styles.text}`}>{outcome.message}</div>
    </div>
  );
}
