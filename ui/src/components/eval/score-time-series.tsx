/**
 * Epic #194 (C.5) — Score-over-time sparkline.
 *
 * Pure SVG so we don't pull in chart libraries that bloat the slim image.
 * Renders a polyline of pass-rate over time per benchmark.
 */
"use client";

import type { BenchRunSummary } from "@/lib/eval-api";

export interface ScoreTimeSeriesProps {
  runs: BenchRunSummary[];
  width?: number;
  height?: number;
}

export function ScoreTimeSeries({ runs, width = 480, height = 120 }: ScoreTimeSeriesProps) {
  if (runs.length < 2) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="score-timeseries-empty">
        Need at least two runs to render a trend.
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
  const points = sorted
    .map((r, i) => {
      const x = padding + i * stepX;
      const y = padding + innerHeight * (1 - clamp(r.score));
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      role="img"
      aria-label="Score over time"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      data-testid="score-timeseries"
      className="block"
    >
      <rect x="0" y="0" width={width} height={height} className="fill-muted/30" />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className="text-primary"
      />
      {sorted.map((r, i) => {
        const x = padding + i * stepX;
        const y = padding + innerHeight * (1 - clamp(r.score));
        return (
          <circle
            key={r.id}
            cx={x}
            cy={y}
            r={3}
            className="fill-primary"
            data-testid={`score-point-${r.id}`}
          />
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
