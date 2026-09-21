"use client";

/**
 * Epic #726 (#736) — per-requirement coverage badge.
 *
 * Renders the deterministic coverage classification computed at synthesis time
 * (`grounded_in_code` | `grounded_in_docs_only` | `no_evidence`) as a compact,
 * colour-coded badge with a plain-language tooltip. The three states are
 * visually distinct (colour + label) and legible for a non-technical BA — the
 * tooltip spells out what each means and, for `no_evidence`, what to do about it.
 *
 * A `null` / unknown coverage (pre-#736 analyses) renders nothing, so old runs
 * degrade gracefully rather than showing a misleading badge.
 */
import type { RequirementCoverage } from "@/lib/analysis-api";

interface CoverageCopy {
  /** Short badge label. */
  label: string;
  /** Plain-language tooltip (what it means + what to do). */
  tooltip: string;
  /** Tailwind colour classes — each state is a distinct hue. */
  className: string;
}

/** Copy + colour per coverage state. Exported so the badge test asserts against it. */
export const COVERAGE_COPY: Record<RequirementCoverage, CoverageCopy> = {
  grounded_in_code: {
    label: "Grounded in code",
    tooltip:
      "This requirement is backed by at least one finding that cites a specific place in the source code (file and line range). NOTE: this means code was CITED, not that the requirement is implemented — see the Verdict badge for that.",
    className: "border-emerald-700/50 bg-emerald-950/40 text-emerald-300",
  },
  grounded_in_docs_only: {
    label: "Docs only",
    tooltip:
      "This requirement is backed only by document citations — no finding traces it to actual source code. It may still be valid, but its link to the implementation is unverified.",
    className: "border-amber-700/50 bg-amber-950/40 text-amber-300",
  },
  no_evidence: {
    label: "No evidence",
    tooltip:
      "No grounded evidence was linked to this requirement. This is NOT the same as a confirmed gap — the analysis may simply have failed to retrieve the relevant code. See the Verdict badge before assuming anything is missing.",
    className: "border-red-700/50 bg-red-950/40 text-red-300",
  },
};

interface Props {
  coverage: RequirementCoverage | null | undefined;
  className?: string;
}

export function CoverageBadge({ coverage, className = "" }: Props): React.ReactElement | null {
  if (!coverage || !(coverage in COVERAGE_COPY)) return null;
  const copy = COVERAGE_COPY[coverage];
  return (
    <span
      data-testid={`coverage-badge-${coverage}`}
      data-coverage={coverage}
      role="status"
      aria-label={`Coverage: ${copy.label}. ${copy.tooltip}`}
      title={copy.tooltip}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${copy.className} ${className}`}
    >
      {copy.label}
    </span>
  );
}
