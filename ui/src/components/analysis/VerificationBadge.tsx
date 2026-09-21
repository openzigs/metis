"use client";

/**
 * Epic #727 (#740) — per-finding verification badge.
 *
 * Renders the deterministic verifier verdict set BEFORE synthesis (`confirmed` |
 * `unverified`) as a compact, colour-coded badge with a plain-language tooltip.
 * The two states are visually distinct (colour + label) and legible for a
 * non-technical BA: an `unverified` badge signals "the analysis could NOT confirm
 * this finding against the code" so the BA knows to treat it with caution.
 *
 * A `null` / unknown status (a doc-only or generic finding that made no code
 * claim, or a pre-#740 run) renders nothing, so those findings degrade gracefully
 * rather than showing a misleading badge.
 */
import type { FindingVerificationStatus } from "@/lib/analysis-api";

interface VerificationCopy {
  /** Short badge label. */
  label: string;
  /** Plain-language tooltip (what it means + what to do). */
  tooltip: string;
  /** Tailwind colour classes — each state is a distinct hue. */
  className: string;
}

/** Copy + colour per verification state. Exported so the badge test asserts against it. */
export const VERIFICATION_COPY: Record<FindingVerificationStatus, VerificationCopy> = {
  confirmed: {
    label: "Confirmed",
    tooltip:
      "The verifier confirmed this finding against the retrieved source code: at least one cited file and line range was actually found in the code. Its code evidence is supported.",
    className: "border-emerald-700/50 bg-emerald-950/40 text-emerald-300",
  },
  unverified: {
    label: "Unverified",
    tooltip:
      "The analysis could NOT confirm this finding against the code: every code location it cited was missing from the retrieved source. Review it manually before acting — it is still shown, but its evidence is unproven.",
    className: "border-amber-700/50 bg-amber-950/40 text-amber-300",
  },
  // Issue #773 — the finding claims something is NOT in the codebase, but the
  // code search that would have shown otherwise did not work. Distinct hue from
  // `unverified` (a wrong citation) because the failure mode is different and far
  // more expensive: acting on it means rebuilding code you may already have.
  "could-not-verify": {
    label: "Could not verify",
    tooltip:
      "This finding claims something is missing from the code — but the analysis could not actually search the code (its searches failed, returned nothing, or ran out of budget). This is NOT a confirmed gap. Do not plan work from it: re-run the analysis or check the code manually.",
    className: "border-violet-700/50 bg-violet-950/40 text-violet-300",
  },
};

interface Props {
  status: FindingVerificationStatus | null | undefined;
  className?: string;
}

export function VerificationBadge({ status, className = "" }: Props): React.ReactElement | null {
  if (!status || !(status in VERIFICATION_COPY)) return null;
  const copy = VERIFICATION_COPY[status];
  return (
    <span
      data-testid={`verification-badge-${status}`}
      data-verification={status}
      role="status"
      aria-label={`Verification: ${copy.label}. ${copy.tooltip}`}
      title={copy.tooltip}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${copy.className} ${className}`}
    >
      {copy.label}
    </span>
  );
}
