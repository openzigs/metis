"use client";

/**
 * Issue #737 (Epic #726) — requirement→findings→code→tests traceability matrix.
 *
 * One row per synthesized requirement; columns for the linked findings, the code
 * locations they cite (`filePath:startLine-endLine`, reusing the #734 locator
 * format), the best-effort detected tests, and the #736 coverage badge. Every
 * cell has an explicit empty state ("none" / "none detected") so a requirement
 * with no code or tests never renders a blank, ambiguous cell.
 *
 * The matrix is fetched from the server aggregation endpoint and can be exported
 * (CSV or markdown) — the export is serialized server-side and streamed as a
 * downloadable attachment. The table scrolls horizontally within its own
 * container so a wide matrix never breaks the page layout.
 */
import { useQuery, useMutation } from "@tanstack/react-query";
import { analysisApi, type TraceabilityRow } from "@/lib/analysis-api";
import { triggerDownload } from "@/lib/plugins-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CoverageBadge } from "@/components/analysis/CoverageBadge";
import { VerdictBadge } from "@/components/analysis/VerdictBadge";

interface Props {
  projectId: string;
  analysisId: string;
  /** Only fetch once the run has completed (requirements exist). */
  enabled?: boolean;
}

/** Render a code location as `filePath:start-end` with a provenance suffix. */
function codeLocationLabel(loc: TraceabilityRow["codeLocations"][number]): string {
  const range = loc.startLine != null ? `:${loc.startLine}-${loc.endLine ?? loc.startLine}` : "";
  return `${loc.filePath}${range}`;
}

export function TraceabilityMatrix({
  projectId,
  analysisId,
  enabled = true,
}: Props): React.ReactElement | null {
  const query = useQuery({
    queryKey: ["traceability", projectId, analysisId],
    queryFn: () => analysisApi.getTraceability(projectId, analysisId),
    enabled,
  });

  const exportMutation = useMutation({
    mutationFn: (format: "csv" | "md") =>
      analysisApi.exportTraceability(projectId, analysisId, format),
    onSuccess: ({ blob, filename }) => triggerDownload(blob, filename),
  });

  if (!enabled) return null;

  const rows = query.data?.rows ?? [];

  return (
    <section data-testid="traceability-matrix" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Traceability matrix
          </h4>
          <p className="text-xs text-zinc-500">
            Requirement → findings → code → tests. Tests are detected from the code graph
            (best-effort).
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="outline"
            data-testid="traceability-export-csv"
            disabled={rows.length === 0 || exportMutation.isPending}
            onClick={() => exportMutation.mutate("csv")}
          >
            Export CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="traceability-export-md"
            disabled={rows.length === 0 || exportMutation.isPending}
            onClick={() => exportMutation.mutate("md")}
          >
            Export Markdown
          </Button>
        </div>
      </div>

      {exportMutation.isError ? (
        <p className="text-xs text-red-400" role="alert">
          Export failed. Please try again.
        </p>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-zinc-500">Loading traceability…</p>
      ) : query.isError ? (
        <p className="text-sm text-red-400" role="alert">
          Could not load the traceability matrix.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No requirements to trace yet. Complete an analysis to populate the matrix.
        </p>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[720px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400">
                <th className="p-2 font-medium">Requirement</th>
                <th className="p-2 font-medium">Verdict</th>
                <th className="p-2 font-medium">Findings</th>
                <th className="p-2 font-medium">Code locations</th>
                <th className="p-2 font-medium">Tests</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.requirementId}
                  data-testid={`traceability-row-${row.requirementId}`}
                  className="border-b border-zinc-900 align-top"
                >
                  <td className="p-2">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-zinc-200">{row.title}</span>
                      <CoverageBadge coverage={row.coverage} />
                    </div>
                  </td>
                  {/* Issue #773 — the verdict column. Coverage alone was read as
                      "no_evidence ⇒ gap"; the verdict says outright whether the
                      requirement is a confirmed gap or merely unverified. */}
                  <td className="p-2">
                    {row.verdict ? (
                      <VerdictBadge verdict={row.verdict} />
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="p-2">
                    {row.findings.length === 0 ? (
                      <span className="text-zinc-600">none</span>
                    ) : (
                      <ul className="space-y-1">
                        {row.findings.map((f) => (
                          <li key={f.id} className="text-zinc-300">
                            {f.title} <span className="text-zinc-500">({f.severity})</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="p-2">
                    {row.codeLocations.length === 0 ? (
                      <span className="text-zinc-600">none</span>
                    ) : (
                      <ul className="space-y-1">
                        {row.codeLocations.map((loc) => (
                          <li
                            key={`${loc.source}:${loc.filePath}:${loc.startLine}`}
                            className="font-mono text-zinc-300"
                            title={loc.source}
                          >
                            {codeLocationLabel(loc)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="p-2">
                    {row.tests.length === 0 ? (
                      <span className="text-zinc-600">none detected</span>
                    ) : (
                      <ul className="space-y-1">
                        {row.tests.map((t) => (
                          <li key={`${t.filePath}:${t.symbol}`} className="font-mono text-zinc-300">
                            {t.filePath}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
