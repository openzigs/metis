"use client";

/**
 * Issue #773 — per-requirement VERDICT badge.
 *
 * The single most consequential label in the product: it is what a BA reads
 * before deciding to fund work. The three states are deliberately far apart
 * visually AND semantically:
 *
 *   - `implemented`      (emerald) — code was retrieved and cited that satisfies it.
 *   - `gap-confirmed`    (red)     — the code WAS searched and genuinely lacks it.
 *   - `could-not-verify` (violet)  — we do not know. NOT a gap. The whole point of
 *                                    #773: "we could not retrieve it" must never
 *                                    read as "it does not exist".
 *
 * A `null` verdict (no code agent in the run, or a pre-#773 row) renders nothing
 * rather than an alarming placeholder.
 */
import type { RequirementVerdict } from "@/lib/analysis-api";

interface VerdictCopy {
  label: string;
  tooltip: string;
  className: string;
}

/** Copy + colour per verdict. Exported so tests assert against it rather than duplicating strings. */
export const VERDICT_COPY: Record<RequirementVerdict, VerdictCopy> = {
  implemented: {
    label: "Implemented",
    tooltip:
      "The code agent retrieved and cited code that satisfies this requirement. Check the cited locations before closing it out.",
    className: "border-emerald-700/50 bg-emerald-950/40 text-emerald-300",
  },
  "gap-confirmed": {
    label: "Gap confirmed",
    tooltip:
      "The code agent successfully searched the codebase and the code it inspected does NOT satisfy this requirement. This is the only state that means 'this needs building' — see the searched scope for what was actually checked.",
    className: "border-red-700/50 bg-red-950/40 text-red-300",
  },
  "could-not-verify": {
    label: "Could not verify",
    tooltip:
      "The analysis could NOT determine whether this requirement is implemented: its code searches failed, returned nothing usable, or never reached this requirement. This is NOT a confirmed gap — the functionality may well already exist. Re-run the analysis or check the code before planning work.",
    className: "border-violet-700/50 bg-violet-950/40 text-violet-300",
  },
};

interface Props {
  verdict: RequirementVerdict | null | undefined;
  className?: string;
}

export function VerdictBadge({ verdict, className = "" }: Props): React.ReactElement | null {
  if (!verdict || !(verdict in VERDICT_COPY)) return null;
  const copy = VERDICT_COPY[verdict];
  return (
    <span
      data-testid={`verdict-badge-${verdict}`}
      data-verdict={verdict}
      role="status"
      aria-label={`Verdict: ${copy.label}. ${copy.tooltip}`}
      title={copy.tooltip}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${copy.className} ${className}`}
    >
      {copy.label}
    </span>
  );
}
