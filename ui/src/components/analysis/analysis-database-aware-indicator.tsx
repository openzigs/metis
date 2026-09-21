"use client";

/**
 * Issue #859 (Epic #852 Phase 4b) — database-aware-analysis "ran / skipped +
 * why" indicator on the analysis results page.
 *
 * Surfaces the SAME resolver decision (#854) that gates both the run path
 * (`metadata.databaseAware`, #855) and the gap-report path (#856) — a small,
 * always-honest status badge so a run never looks like it silently skipped
 * schema reasoning. Reuses the shared `AnalysisDatabaseAwareReason` union
 * verbatim rather than redefining the reason vocabulary; only the human-
 * readable copy lives here.
 *
 * The "skipped — no schema data" states link to the SAME `/projects/:id/
 * connections` route the #858 project-settings card uses (it hosts both
 * "connect a database" and the repo re-ingest actions), so there is one
 * consistent remediation path across the app.
 *
 * Renders nothing when there is no resolved decision (pre-#855 runs, or runs
 * where neither the code nor database agent ran) — no state is invented.
 */
import Link from "next/link";
import type { AnalysisDatabaseAware, AnalysisDatabaseAwareReason } from "@/lib/analysis-api";

interface Props {
  databaseAware: AnalysisDatabaseAware | null;
  projectId: string;
}

type Tone = "ran" | "off" | "skipped";

interface ReasonCopy {
  label: string;
  tone: Tone;
}

/**
 * Human-readable label per machine reason. `on` / `auto->resolved-on` both
 * read as "on" (the auto variant is distinguished only by badge title, so the
 * headline never implies the operator flipped a switch that resolved itself);
 * both no-schema-data reasons read as "skipped" and pair with the actionable
 * hint below — the resolver already collapsed them to the same UI meaning.
 */
const REASON_COPY: Record<AnalysisDatabaseAwareReason, ReasonCopy> = {
  on: { label: "Database-aware analysis: on", tone: "ran" },
  "auto->resolved-on": { label: "Database-aware analysis: on", tone: "ran" },
  off: { label: "Database-aware analysis: off", tone: "off" },
  "auto->resolved-off-no-data": { label: "Database-aware analysis: skipped", tone: "skipped" },
  "skipped-no-schema-data": { label: "Database-aware analysis: skipped", tone: "skipped" },
  // #849 — an operator kill-switch, not a data gap: reads as "off" (no
  // connect-a-database hint, since connecting one would change nothing).
  "auto->platform-disabled": { label: "Database-aware analysis: off", tone: "off" },
};

const REASON_TITLE: Record<AnalysisDatabaseAwareReason, string> = {
  on: "Explicit override — always runs for this project.",
  "auto->resolved-on": "Auto — a connected database or schema graph was detected.",
  off: "Explicit override — never runs for this project.",
  "auto->resolved-off-no-data":
    "Auto — no connected database or schema graph was available for this run.",
  "skipped-no-schema-data":
    "Enabled for this project, but no schema data was available to run against.",
  "auto->platform-disabled":
    "Disabled by platform configuration — an administrator turned database-aware analysis off for this deployment.",
};

const SKIPPED_NO_DATA_REASONS: ReadonlySet<AnalysisDatabaseAwareReason> = new Set([
  "skipped-no-schema-data",
  "auto->resolved-off-no-data",
]);

const TONE_CLASS: Record<Tone, string> = {
  ran: "border-emerald-700/50 bg-emerald-950/40 text-emerald-300",
  off: "border-zinc-700/60 bg-zinc-900/60 text-zinc-400",
  skipped: "border-amber-700/50 bg-amber-950/20 text-amber-300",
};

export function AnalysisDatabaseAwareIndicator({
  databaseAware,
  projectId,
}: Props): React.ReactElement | null {
  if (!databaseAware) return null;

  const { reason } = databaseAware;
  const copy = REASON_COPY[reason];
  const showSkippedHint = SKIPPED_NO_DATA_REASONS.has(reason);

  return (
    <div
      data-testid="analysis-database-aware-indicator"
      className="flex flex-wrap items-center gap-2 text-xs"
    >
      <span
        role="status"
        data-testid="database-aware-badge"
        data-reason={reason}
        title={REASON_TITLE[reason]}
        className={`inline-flex items-center rounded-full border px-2 py-0.5 font-semibold ${TONE_CLASS[copy.tone]}`}
      >
        {copy.label}
      </span>
      {showSkippedHint ? (
        <span data-testid="database-aware-skipped-hint" className="text-amber-200/80">
          Schema-impact analysis skipped — no schema data.{" "}
          <Link
            href={`/projects/${projectId}/connections`}
            data-testid="database-aware-connections-link"
            className="underline decoration-dotted underline-offset-2 hover:text-amber-100"
          >
            Connect a database or re-ingest
          </Link>
          .
        </span>
      ) : null}
    </div>
  );
}
