/**
 * Epic #803 (Epic 09) — Domain Eval corpus-F1 trend chart.
 *
 * Pure SVG (no chart library) so the slim image stays slim. Plots corpus F1
 * over time and flags any run that breached the week-over-week drift
 * threshold with a hollow red marker.
 */
"use client";

import type { DomainEvalRunSummary } from "@/lib/eval-api";

export interface DomainTrendChartProps {
  runs: DomainEvalRunSummary[];
  width?: number;
  height?: number;
}

export function DomainTrendChart({ runs, width = 480, height = 140 }: DomainTrendChartProps) {
  if (runs.length < 2) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="domain-trend-empty">
        Need at least two runs to render a corpus-F1 trend.
      </p>
    );
  }
  // Sort ascending by startedAt so the line reads left-to-right in time order.
  const sorted = [...runs].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  );
  const padding = 16;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const stepX = innerWidth / (sorted.length - 1);
  const coord = (r: DomainEvalRunSummary, i: number) => ({
    x: padding + i * stepX,
    y: padding + innerHeight * (1 - clamp(r.corpusF1)),
  });
  const points = sorted.map((r, i) => {
    const { x, y } = coord(r, i);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      role="img"
      aria-label="Corpus F1 over time"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      data-testid="domain-trend-chart"
      className="block"
    >
      <rect x="0" y="0" width={width} height={height} className="fill-muted/30" />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className="text-primary"
      />
      {sorted.map((r, i) => {
        const { x, y } = coord(r, i);
        return (
          <circle
            key={r.runId}
            cx={x}
            cy={y}
            r={r.driftAlert ? 5 : 3}
            fill={r.driftAlert ? "none" : "currentColor"}
            stroke={r.driftAlert ? "currentColor" : "none"}
            strokeWidth={r.driftAlert ? 2 : 0}
            className={r.driftAlert ? "text-red-600" : "fill-primary text-primary"}
            data-testid={`domain-point-${r.runId}`}
            data-drift-alert={r.driftAlert ? "true" : "false"}
          >
            <title>{`${r.runId}: F1 ${(r.corpusF1 * 100).toFixed(1)}%`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

function clamp(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
