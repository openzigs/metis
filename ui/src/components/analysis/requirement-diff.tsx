"use client";

/**
 * Issue #743 (Epic #728) — diff-style current-vs-proposed view.
 *
 * For every requirement that CHANGED between a base ("current") and this head
 * ("proposed") run, a side-by-side card: left = the base requirement + its
 * code-grounded current-implementation evidence (reusing the #734 `CodeCitation`
 * locator); right = the proposed requirement text + the #742 gap report. The
 * body text is word-diffed so additions/removals are visible to a business
 * analyst. A run-picker selects the base run (default: the previous run).
 *
 * The server composes the Change Analysis engine's requirement diffing; this
 * component only renders the assembled diff. When there is no base run to compare
 * against, an explicit empty state renders rather than a fabricated "all new".
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  analysisApi,
  type AnalysisListItem,
  type RequirementDiffEntry,
  type RequirementDiffSeverity,
} from "@/lib/analysis-api";
import { Card } from "@/components/ui/card";
import { CodeCitation } from "@/components/findings/code-citation";

interface Props {
  projectId: string;
  analysisId: string;
  /** Completed runs of the project, used to populate the base run-picker. */
  analyses: AnalysisListItem[];
  /** Only fetch once the head run has completed. */
  enabled?: boolean;
}

const SEVERITY_CLASS: Record<RequirementDiffSeverity, string> = {
  critical: "border-red-700/60 bg-red-950/40 text-red-300",
  high: "border-orange-700/60 bg-orange-950/40 text-orange-300",
  medium: "border-amber-700/60 bg-amber-950/40 text-amber-300",
  low: "border-zinc-700/60 bg-zinc-900/60 text-zinc-400",
};

const CHANGE_LABEL: Record<RequirementDiffEntry["changeType"], string> = {
  added: "Added",
  removed: "Removed",
  modified: "Modified",
};

/** One word-diff token: unchanged, inserted (proposed-only), or deleted (current-only). */
export interface DiffToken {
  text: string;
  status: "equal" | "insert" | "delete";
}

/**
 * PURE word-level diff between two strings via a longest-common-subsequence
 * backtrace. `delete` tokens exist only in `current`, `insert` only in
 * `proposed`. Small and exported so it can be unit-tested directly.
 */
export function diffWords(current: string, proposed: string): DiffToken[] {
  const a = current.length ? current.split(/(\s+)/).filter((t) => t.length > 0) : [];
  const b = proposed.length ? proposed.split(/(\s+)/).filter((t) => t.length > 0) : [];
  const m = a.length;
  const n = b.length;
  // LCS length table.
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      tokens.push({ text: a[i]!, status: "equal" });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      tokens.push({ text: a[i]!, status: "delete" });
      i++;
    } else {
      tokens.push({ text: b[j]!, status: "insert" });
      j++;
    }
  }
  while (i < m) tokens.push({ text: a[i++]!, status: "delete" });
  while (j < n) tokens.push({ text: b[j++]!, status: "insert" });
  return tokens;
}

function SeverityBadge({ severity }: { severity: RequirementDiffSeverity }): React.ReactElement {
  return (
    <span
      data-testid="diff-severity"
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${SEVERITY_CLASS[severity]}`}
    >
      {severity}
    </span>
  );
}

/** Render the body with inserted words highlighted (proposed) or struck (current). */
function DiffText({
  tokens,
  side,
}: {
  tokens: DiffToken[];
  side: "current" | "proposed";
}): React.ReactElement {
  return (
    <p className="text-xs leading-relaxed text-zinc-300">
      {tokens.map((t, idx) => {
        if (t.status === "equal") return <span key={idx}>{t.text}</span>;
        if (side === "current" && t.status === "delete") {
          return (
            <span
              key={idx}
              data-testid="diff-removed"
              className="rounded bg-red-950/60 text-red-300 line-through"
            >
              {t.text}
            </span>
          );
        }
        if (side === "proposed" && t.status === "insert") {
          return (
            <span
              key={idx}
              data-testid="diff-added"
              className="rounded bg-emerald-950/60 text-emerald-300"
            >
              {t.text}
            </span>
          );
        }
        return null;
      })}
    </p>
  );
}

function DiffCard({ entry }: { entry: RequirementDiffEntry }): React.ReactElement {
  const currentBody = entry.current?.body ?? "";
  const proposedBody = entry.proposed?.body ?? "";
  const tokens = diffWords(currentBody, proposedBody);

  return (
    <Card
      data-testid={`requirement-diff-card-${entry.current?.requirementId ?? entry.proposed?.requirementId}`}
      className="space-y-3 border-zinc-800 bg-zinc-900/30 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            data-testid="diff-change-type"
            className="inline-flex items-center rounded border border-zinc-700/60 bg-zinc-900/60 px-2 py-0.5 text-[11px] font-semibold text-zinc-300"
          >
            {CHANGE_LABEL[entry.changeType]}
          </span>
          <SeverityBadge severity={entry.severity} />
          <span
            data-testid="diff-impact"
            className="inline-flex items-center rounded-full border border-sky-700/50 bg-sky-950/40 px-2 py-0.5 text-[11px] font-semibold text-sky-300"
            title="Change impact score (0–1) from the Change Analysis engine."
          >
            impact {entry.impactScore.toFixed(2)}
          </span>
        </div>
      </div>

      <p data-testid="diff-summary" className="text-xs text-zinc-400">
        {entry.diffSummary}
      </p>

      {/* Side-by-side current vs proposed; wide content scrolls in its own box. */}
      <div className="overflow-x-auto">
        <div className="grid min-w-[32rem] grid-cols-1 gap-3 md:grid-cols-2">
          {/* Current (base) side */}
          <section
            data-testid="diff-current"
            className="space-y-2 rounded border border-zinc-800/70 bg-zinc-950/40 p-3"
          >
            <h6 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Current
            </h6>
            {entry.current ? (
              <>
                <h5 className="text-sm font-semibold text-zinc-100">{entry.current.title}</h5>
                <DiffText tokens={tokens} side="current" />
                <div className="space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    Current implementation
                  </p>
                  {entry.current.hasEvidence ? (
                    <ul className="space-y-1">
                      {entry.current.codeCitations.map((c) => (
                        <CodeCitation
                          key={`${c.filePath}:${c.startLine}-${c.endLine}`}
                          citation={c}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p data-testid="diff-current-no-evidence" className="text-xs text-amber-300">
                      No source evidence linked for the current requirement.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <p data-testid="diff-no-current" className="text-xs text-zinc-500">
                New requirement — nothing existed before.
              </p>
            )}
          </section>

          {/* Proposed (head) side */}
          <section
            data-testid="diff-proposed"
            className="space-y-2 rounded border border-zinc-800/70 bg-zinc-950/40 p-3"
          >
            <h6 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Proposed
            </h6>
            {entry.proposed ? (
              <>
                <h5 className="text-sm font-semibold text-zinc-100">{entry.proposed.title}</h5>
                <DiffText tokens={tokens} side="proposed" />
                {entry.proposed.gapReport && entry.proposed.gapReport.gapFindings.length > 0 ? (
                  <div className="space-y-1">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                      Gap
                    </p>
                    <ul className="space-y-1">
                      {entry.proposed.gapReport.gapFindings.map((f) => (
                        <li
                          key={f.id}
                          data-testid={`diff-gap-finding-${f.id}`}
                          className="rounded border border-zinc-800/70 bg-zinc-950/60 p-2 text-xs text-zinc-400"
                        >
                          <span className="font-medium text-zinc-200">{f.title}</span>
                          <p className="mt-0.5">{f.body}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">
                    No gap findings linked to the proposed requirement.
                  </p>
                )}
              </>
            ) : (
              <p data-testid="diff-no-proposed" className="text-xs text-zinc-500">
                Removed requirement — no proposed version.
              </p>
            )}
          </section>
        </div>
      </div>
    </Card>
  );
}

export function RequirementDiff({
  projectId,
  analysisId,
  analyses,
  enabled = true,
}: Props): React.ReactElement | null {
  // Undefined ⇒ let the server default to the previous completed run.
  const [baseId, setBaseId] = useState<string | undefined>(undefined);

  const baseOptions = useMemo(
    () => analyses.filter((a) => a.id !== analysisId && a.status === "completed"),
    [analyses, analysisId],
  );

  const query = useQuery({
    queryKey: ["requirement-diff", projectId, analysisId, baseId ?? "auto"],
    queryFn: () => analysisApi.getRequirementDiff(projectId, analysisId, baseId),
    enabled,
  });

  if (!enabled) return null;

  const diff = query.data;
  const entries = diff?.entries ?? [];

  return (
    <section data-testid="requirement-diff" className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Current vs proposed
          </h4>
          <p className="text-xs text-zinc-500">
            Side-by-side diff of the requirements that CHANGED against a base run. Current
            implementation evidence on the left, the proposed requirement + gap on the right.
          </p>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-zinc-400">
          <span>Compare to</span>
          <select
            data-testid="diff-base-picker"
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
            value={baseId ?? ""}
            onChange={(e) => setBaseId(e.target.value || undefined)}
          >
            <option value="">Previous run (auto)</option>
            {baseOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {new Date(a.startedAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-zinc-500">Loading current-vs-proposed diff…</p>
      ) : query.isError ? (
        <p className="text-sm text-red-400" role="alert">
          Could not load the current-vs-proposed diff.
        </p>
      ) : diff && diff.baseAnalysisId == null ? (
        <p data-testid="diff-no-base" className="text-sm text-zinc-500">
          No prior run to compare against. Run the analysis again, or pick a base run once one
          exists.
        </p>
      ) : entries.length === 0 ? (
        <p data-testid="diff-no-changes" className="text-sm text-zinc-500">
          No requirement changes between these two runs.
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry, idx) => (
            <DiffCard
              key={`${entry.current?.requirementId ?? ""}:${entry.proposed?.requirementId ?? ""}:${idx}`}
              entry={entry}
            />
          ))}
        </div>
      )}
    </section>
  );
}
