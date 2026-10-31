"use client";

/**
 * Issue #773 — per-requirement VERDICT badge.
 *
 * The single most consequential label in the product: it is what a BA reads
 * before deciding to fund work. The states are deliberately far apart
 * visually AND semantically:
 *
 *   - `implemented`      (success) — code was retrieved and cited that satisfies it.
 *   - `partial`          (warning) — #1610: some acceptance criteria are backed by cited
 *                                    code, a gap is confirmed for others.
 *   - `gap-confirmed`    (destructive) — the code WAS searched and genuinely lacks it.
 *   - `could-not-verify` (neutral, dashed) — we do not know. NOT a gap. The whole point of
 *                                    #773: "we could not retrieve it" must never
 *                                    read as "it does not exist".
 *
 * A `null` verdict (no code agent in the run, or a pre-#773 row) renders nothing
 * rather than an alarming placeholder. #1615 — a verdict string this build does
 * not know (a newer server) renders a neutral "Verdict unknown" badge: never
 * nothing (it is a verdict), never a crash, and never a known verdict's colour.
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
    className: "border-success/40 bg-success-muted text-success",
  },
  partial: {
    label: "Partly implemented",
    // #1615 — the gap report has no per-criterion met/unmet view (the snapshot
    // does not carry `criterionEvidence`), so this must not send the reader there
    // to learn which criteria are met: it points at what IS shown.
    tooltip:
      "Some of this requirement's acceptance criteria are backed by cited code, and the code agent confirmed a gap for at least one other. Build only the missing part: the cited code shows what exists, the gap findings show what is still missing.",
    className: "border-warning/40 bg-warning-muted text-warning",
  },
  "gap-confirmed": {
    label: "Gap confirmed",
    tooltip:
      "The code agent successfully searched the codebase and the code it inspected does NOT satisfy this requirement. This is the state that means 'this needs building' in full — see the searched scope for what was actually checked.",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  "could-not-verify": {
    label: "Could not verify",
    tooltip:
      "The analysis could NOT determine whether this requirement is implemented: its code searches failed, returned nothing usable, or never reached this requirement. This is NOT a confirmed gap — the functionality may well already exist. Re-run the analysis or check the code before planning work.",
    className: "border-dashed border-muted-foreground/60 bg-muted text-foreground",
  },
};

/** #1615 — the neutral state for a verdict string this build does not recognise. */
export const UNKNOWN_VERDICT_COPY: VerdictCopy = {
  label: "Verdict unknown",
  tooltip:
    "The analysis returned a verdict this version of METIS does not recognise. Treat this requirement as unverified and check the cited code before planning work.",
  className: "border-muted-foreground/40 bg-muted text-muted-foreground",
};

interface Props {
  verdict: RequirementVerdict | null | undefined;
  className?: string;
}

export function VerdictBadge({ verdict, className = "" }: Props): React.ReactElement | null {
  if (!verdict) return null;
  const known = Object.hasOwn(VERDICT_COPY, verdict);
  const copy = known ? VERDICT_COPY[verdict] : UNKNOWN_VERDICT_COPY;
  const key = known ? verdict : "unknown";
  return (
    <span
      data-testid={`verdict-badge-${key}`}
      data-verdict={key}
      role="status"
      aria-label={`Verdict: ${copy.label}. ${copy.tooltip}`}
      title={copy.tooltip}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${copy.className} ${className}`}
    >
      {copy.label}
    </span>
  );
}
